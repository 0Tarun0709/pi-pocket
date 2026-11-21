import { createServer, type Server } from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const page = fileURLToPath(new URL("../../web/index.html", import.meta.url));
const port = 18789;
const disabledFile = fileURLToPath(new URL("../remote-disabled", import.meta.url));

type ToolMessage = { role: "tool"; id: string; name: string; args: unknown; output?: unknown; state: "running" | "done" | "error" | "unknown" };
type DisplayMessage = { role: "user" | "assistant"; text: string } | ToolMessage;

function display(message: any): DisplayMessage | undefined {
  if (message?.role !== "user" && message?.role !== "assistant") return;
  const text = typeof message.content === "string" ? message.content :
    message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  if (text) return { role: message.role as "user" | "assistant", text };
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let messages: DisplayMessage[] = [];
  let streaming: DisplayMessage | undefined;
  let waiting: { kind: string; title?: string } | undefined;
  let disabled = false;
  let queued: string[] = [];
  let queueTimer: ReturnType<typeof setInterval> | undefined;

  function stopServer() {
    if (queueTimer) clearInterval(queueTimer);
    queueTimer = undefined;
    const active = server;
    server = undefined;
    if (active) { active.close(); active.closeAllConnections(); }
  }

  function tool(id: string) {
    return messages.find((item): item is ToolMessage => item.role === "tool" && item.id === id);
  }

  function loadHistory(entries: ReturnType<import("@mariozechner/pi-coding-agent").SessionManager["getBranch"]>) {
    messages = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      const item = display(message);
      if (item) messages.push(item);
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type === "toolCall") messages.push({ role: "tool", id: part.id, name: part.name, args: part.arguments, state: "unknown" });
        }
      } else if (message.role === "toolResult") {
        const existing = tool(message.toolCallId);
        if (existing) Object.assign(existing, { output: { content: message.content, details: message.details }, state: message.isError ? "error" : "done" });
        else messages.push({ role: "tool", id: message.toolCallId, name: message.toolName, args: undefined, output: { content: message.content, details: message.details }, state: message.isError ? "error" : "done" });
      }
    }
    streaming = undefined;
    waiting = undefined;
  }

  pi.registerCommand("remote", {
    description: "Show Pi Remote address, or use /remote enable after an all-stop",
    handler: async (args, ctx) => {
      if (args.trim() === "enable") {
        if (server) { ctx.ui.notify("Pi Remote is already running", "info"); return; }
        try {
          await startServer(ctx);
          await unlink(disabledFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          disabled = false;
        } catch (error) {
          stopServer();
          ctx.ui.notify(`Pi Remote could not start: ${error}`, "error");
        }
        return;
      }
      const address = server?.address();
      ctx.ui.notify(address && typeof address !== "string" ? `Pi Remote: http://127.0.0.1:${address.port}` : "Pi Remote is not running", "info");
    },
  });

  async function startServer(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext) {
    const [html, marked, dompurify, highlight] = await Promise.all([
      readFile(page),
      readFile(new URL("../../node_modules/marked/lib/marked.umd.js", import.meta.url)),
      readFile(new URL("../../node_modules/dompurify/dist/purify.min.js", import.meta.url)),
      readFile(new URL("../../node_modules/@highlightjs/cdn-assets/highlight.min.js", import.meta.url)),
    ]);
    server = createServer(async (req, res) => {
      const host = req.headers.host;
      const address = server?.address();
      const expectedHost = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
      // Restrict requests to the local origin, including against DNS rebinding.
      if (host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {
        res.writeHead(403).end();
        return;
      }
      if (disabled) { res.writeHead(503).end("Pi Remote disabled"); return; }
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      } else if (req.method === "GET" && (req.url === "/marked.js" || req.url === "/purify.js" || req.url === "/highlight.js")) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(req.url === "/marked.js" ? marked : req.url === "/purify.js" ? dompurify : highlight);
      } else if (req.method === "GET" && req.url === "/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          messages: streaming ? [...messages, streaming] : messages,
          busy: !ctx.isIdle(),
          waiting,
          queued: queued.length,
        }));
      } else if (req.method === "POST" && req.url === "/api/prompt") {
        if (req.headers.origin !== `http://${expectedHost}` || req.headers["content-type"] !== "application/json") {
          res.writeHead(403).end();
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64_000) { res.writeHead(413).end(); return; }
        }
        try {
          const { text } = JSON.parse(body);
          if (typeof text !== "string" || !text.trim()) throw new Error("Empty prompt");
          if (disabled) { res.writeHead(503).end("Pi Remote disabled"); return; }
          queued.push(text.trim());
          res.writeHead(202).end();
        } catch {
          res.writeHead(400).end("Invalid prompt");
        }
      } else if (req.method === "POST" && (req.url === "/api/stop" || req.url === "/api/stop-all")) {
        if (req.headers.origin !== `http://${expectedHost}` || req.headers["content-type"] !== "application/json") {
          res.writeHead(403).end();
          return;
        }
        if (req.url === "/api/stop-all") {
          disabled = true;
          queued = [];
          ctx.abort();
          let closed = false;
          const closeOnce = () => { if (!closed) { closed = true; stopServer(); } };
          res.once("finish", closeOnce);
          res.once("close", closeOnce);
          try {
            await writeFile(disabledFile, "Pi Remote disabled. Use /remote enable to restart.\n");
            res.writeHead(200).end();
          } catch (error) {
            ctx.ui.notify(`Pi Remote disabled, but could not persist the lock: ${error}`, "error");
            res.writeHead(500).end("Disabled until restart, but could not save the lock");
          }
        } else {
          ctx.abort();
          res.writeHead(200).end();
        }
      } else {
        res.writeHead(404).end();
      }
    });
    server.on("error", (error) => ctx.ui.notify(`Pi Remote: ${error.message}`, "error"));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address && typeof address !== "string") ctx.ui.notify(`Pi Remote: http://127.0.0.1:${address.port}`, "info");
    queueTimer = setInterval(() => {
      if (!disabled && queued.length && ctx.isIdle()) {
        const text = queued.shift()!;
        try { pi.sendUserMessage(text); }
        catch (error) { queued.unshift(text); ctx.ui.notify(`Pi Remote could not send: ${error}`, "error"); }
      }
    }, 250);
    queueTimer.unref();
  }

  pi.on("session_start", async (_event, ctx) => {
    loadHistory(ctx.sessionManager.getBranch());
    try {
      await readFile(disabledFile);
      disabled = true;
      ctx.ui.notify("Pi Remote disabled. Use /remote enable to restart.", "info");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      disabled = false;
      await startServer(ctx);
    }
  });

  pi.on("session_tree", async (_event, ctx) => { loadHistory(ctx.sessionManager.getBranch()); });
  pi.on("ui_prompt_start", async (event) => { waiting = { kind: event.kind, title: event.title }; });
  pi.on("ui_prompt_end", async () => { waiting = undefined; });
  pi.on("tool_execution_start", async (event) => {
    messages.push({ role: "tool", id: event.toolCallId, name: event.toolName, args: event.args, state: "running" });
  });
  pi.on("tool_execution_update", async (event) => {
    const item = tool(event.toolCallId);
    if (item) item.output = event.partialResult;
  });
  pi.on("tool_execution_end", async (event) => {
    const item = tool(event.toolCallId);
    if (item) Object.assign(item, { output: event.result, state: event.isError ? "error" : "done" });
  });
  pi.on("message_update", async (event) => { streaming = display(event.message); });
  pi.on("message_end", async (event) => {
    const item = display(event.message);
    if (item) messages.push(item);
    if (event.message.role === "assistant") streaming = undefined;
  });
  pi.on("session_shutdown", async () => {
    queued = [];
    stopServer();
  });
}
