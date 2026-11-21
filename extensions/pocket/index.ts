import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Pairing } from "./auth.ts";

const page = fileURLToPath(new URL("../../web/index.html", import.meta.url));
const require = createRequire(import.meta.url);
const QRCode: typeof import("qrcode") = require("qrcode");
const execFileAsync = promisify(execFile);
const port = 18789;
const stateDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-pocket");
const disabledFile = join(stateDir, "remote-disabled");
const originFile = join(stateDir, "tailscale-origin");

type ToolMessage = { role: "tool"; id: string; name: string; args: unknown; output?: unknown; state: "running" | "done" | "error" | "unknown" };
type DisplayMessage = { role: "user" | "assistant"; text: string } | { role: "source"; via: "tailscale" | "local" } | ToolMessage;

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
  let queued: { text: string; via: "tailscale" | "local" }[] = [];
  let queueTimer: ReturnType<typeof setInterval> | undefined;
  let pairing = new Pairing(stateDir);
  let remoteOrigin: string | undefined;
  let disconnectingTailscale = false;

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

  function loadHistory(entries: ReturnType<import("@earendil-works/pi-coding-agent").SessionManager["getBranch"]>) {
    messages = [];
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "pi-pocket-prompt") {
        const via = (entry.data as { via?: unknown } | undefined)?.via;
        if (via === "tailscale" || via === "local") messages.push({ role: "source", via });
      }
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

  pi.registerEntryRenderer("pi-pocket-prompt", (entry, _options, theme) => {
    const label = (entry.data as { via?: string } | undefined)?.via === "tailscale"
      ? "↳ Pi Pocket · Tailscale address"
      : "↳ Pi Pocket · local address";
    return { render: (width: number) => [theme.fg("dim", label.slice(0, Math.max(0, width)))], invalidate() {} };
  });

  pi.registerCommand("remote", {
    description: "Show address; use /remote pair or /remote devices to manage browser access",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "pair") {
        const address = server?.address();
        if (!address || typeof address === "string") { ctx.ui.notify("Pi Pocket is not running.", "error"); return; }
        const origin = remoteOrigin || `http://127.0.0.1:${address.port}`;
        const code = pairing.issue();
        const qr = QRCode.create(`${origin}/pair#pair=${code}`, { errorCorrectionLevel: "L" });
        const size = qr.modules.size + 8;
        const black = (y: number, x: number) => y >= 4 && x >= 4 && y < size - 4 && x < size - 4 && qr.modules.get(y - 4, x - 4);
        const rows: string[] = [];
        for (let y = 0; y < size; y += 2) {
          let row = "";
          for (let x = 0; x < size; x++) row += black(y, x) ? (black(y + 1, x) ? "█" : "▀") : (black(y + 1, x) ? "▄" : " ");
          rows.push(`\x1b[30;47m${row}\x1b[0m`);
        }
        let showCode = false;
        await ctx.ui.custom<void>((tui, theme, keys, done) => ({
          render(width) {
            const height = tui.terminal?.rows ?? Infinity;
            const codeWidth = Math.max(1, width - 6);
            const codeLines: string[] = [];
            for (let i = 0; i < code.length; i += codeWidth) codeLines.push(`${i ? "      " : "Code: "}${code.slice(i, i + codeWidth)}`.slice(0, width));
            const fits = width >= size && height >= rows.length + 1;
            if (fits && !showCode) {
              const title = remoteOrigin ? "Scan QR · c: code · Esc: close · expires in 2 min" : "Local pairing · c: code · Esc: close · expires in 2 min";
              return [theme.fg("accent", title.slice(0, width)), ...rows, ...(height >= rows.length + codeLines.length + 3 ? [...codeLines, "Open the Pi Pocket address to enter the code.".slice(0, width), "Enter or Esc to close".slice(0, width)] : [])];
            }
            return [theme.fg("accent", "Pairing code · expires in 2 minutes".slice(0, width)), ...codeLines, "Open the Pi Pocket address to enter this code.".slice(0, width), (fits ? "c: QR · Esc: close" : "Enlarge terminal for QR · Esc: close").slice(0, width)];
          },
          handleInput(data) {
            if (data === "c") { showCode = !showCode; tui.requestRender(); }
            else if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")) done();
          },
          invalidate() {},
        }), { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
        return;
      }
      if (input === "devices") {
        const owner = server;
        if (!owner?.listening) { ctx.ui.notify("Pi Pocket is not running in this session. Manage browsers in the session that owns the server.", "error"); return; }
        const browsers = pairing.list();
        if (!browsers.length) { ctx.ui.notify("No paired browsers.", "info"); return; }
        const options = browsers.map((browser) => `${browser.label} · ${browser.id} · paired ${browser.created.slice(0, 10)}`);
        const selected = await ctx.ui.select("Select a browser to revoke", options);
        const index = selected ? options.indexOf(selected) : -1;
        if (index >= 0 && await ctx.ui.confirm("Revoke browser?", `This will disconnect ${options[index]}.`)) {
          if (server !== owner || !owner.listening) { ctx.ui.notify("Pi Pocket stopped; browser was not revoked.", "error"); return; }
          pairing.revoke(browsers[index].id);
          ctx.ui.notify("Browser revoked.", "info");
        }
        return;
      }
      if (input === "unshare") {
        try {
          await unlink(originFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          remoteOrigin = undefined;
          ctx.ui.notify("Pi Pocket no longer accepts the Tailscale hostname. Disable Tailscale Serve separately.", "info");
        } catch (error) { ctx.ui.notify(`Pi Pocket could not remove its origin: ${error}`, "error"); }
        return;
      }
      if (input.startsWith("share ")) {
        const hostname = input.slice(6).toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(hostname) || hostname.length > 253) {
          ctx.ui.notify("Provide the exact Tailscale hostname, without https:// or a port.", "error");
          return;
        }
        try {
          await mkdir(stateDir, { recursive: true, mode: 0o700 });
          await writeFile(originFile, `https://${hostname}`, { mode: 0o600 });
          remoteOrigin = `https://${hostname}`;
          ctx.ui.notify(`Pi Pocket accepts ${remoteOrigin}. Run /remote pair to pair a browser.`, "info");
        } catch (error) { ctx.ui.notify(`Pi Pocket could not save its origin: ${error}`, "error"); }
        return;
      }
      if (input === "enable") {
        if (server) { ctx.ui.notify("Pi Remote is already running", "info"); return; }
        try {
          await startServer(ctx);
          await unlink(join(ctx.cwd, ".pi", "remote-disabled")).catch((error) => { if (error.code !== "ENOENT") throw error; });
          await unlink(disabledFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          disabled = false;
        } catch (error) {
          stopServer();
          ctx.ui.notify(`Pi Remote could not start: ${error}`, "error");
        }
        return;
      }
      const address = server?.address();
      ctx.ui.notify(address && typeof address !== "string" ? `Pi Pocket: http://127.0.0.1:${address.port}${remoteOrigin ? `\nTailscale: ${remoteOrigin}` : ""}\nUse /remote pair to pair a browser; /remote devices to revoke one.` : "Pi Remote is not running", "info");
    },
  });

  async function startServer(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) {
    pairing = new Pairing(stateDir);
    const [html, pairPage, marked, dompurify, highlight] = await Promise.all([
      readFile(page),
      readFile(new URL("../../web/pair.html", import.meta.url)),
      readFile(join(dirname(require.resolve("marked")), "marked.umd.js")),
      readFile(join(dirname(require.resolve("dompurify")), "purify.min.js")),
      readFile(require.resolve("@highlightjs/cdn-assets/highlight.min.js")),
    ]);
    server = createServer(async (req, res) => {
      const host = req.headers.host;
      const address = server?.address();
      const expectedHost = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
      const localOrigin = `http://${expectedHost}`;
      const requestOrigin = host === expectedHost ? localOrigin : remoteOrigin && host === new URL(remoteOrigin).host ? remoteOrigin : undefined;
      if (!requestOrigin || (req.headers.origin && req.headers.origin !== requestOrigin)) {
        res.writeHead(403).end();
        return;
      }
      if (disabled) { res.writeHead(503).end("Pi Remote disabled"); return; }
      res.setHeader("Cache-Control", "no-store");
      const cookieName = requestOrigin === localOrigin ? "pi-pocket-local" : "__Host-pi-pocket";
      const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const browser = pairing.identify(cookie);
      if (req.method === "POST" && req.url === "/api/pair") {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 1024) { res.writeHead(413).end(); return; } }
        try {
          const token = pairing.accept(JSON.parse(body).code, req.headers["user-agent"]);
          if (!token) { res.writeHead(401).end("Invalid or expired pairing code."); return; }
          res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${requestOrigin === localOrigin ? "" : "; Secure"}`);
          res.writeHead(200).end();
        } catch (error) {
          ctx.ui.notify(`Pi Pocket pairing failed: ${error}`, "error");
          res.writeHead(400).end("Could not complete pairing. Generate a new code on the laptop.");
        }
        return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "/pair")) {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(browser && req.url === "/" ? html : pairPage);
      } else if (!browser) {
        res.writeHead(401).end("Pair this browser using /remote pair on the laptop.");
      } else if (req.method === "GET" && (req.url === "/marked.js" || req.url === "/purify.js" || req.url === "/highlight.js")) {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(req.url === "/marked.js" ? marked : req.url === "/purify.js" ? dompurify : highlight);
      } else if (req.method === "GET" && req.url === "/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          messages: streaming ? [...messages, streaming] : messages,
          busy: !ctx.isIdle(),
          waiting,
          queued: queued.length,
          browser,
        }));
      } else if (req.method === "POST" && req.url === "/api/prompt") {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") {
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
          queued.push({ text: text.trim(), via: requestOrigin === remoteOrigin ? "tailscale" : "local" });
          res.writeHead(202).end();
        } catch {
          res.writeHead(400).end("Invalid prompt");
        }
      } else if (req.method === "POST" && req.url === "/api/disconnect-tailscale") {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") {
          res.writeHead(403).end();
          return;
        }
        if (!remoteOrigin || disconnectingTailscale) {
          res.writeHead(409).end("Tailscale access is not configured or is already being disconnected.");
          return;
        }
        disconnectingTailscale = true;
        let routeRemoved = false;
        try {
          const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], { timeout: 10000, maxBuffer: 1024 * 1024 });
          const config = JSON.parse(stdout);
          const host = `${new URL(remoteOrigin).hostname}:443`;
          const handlers = config.Web?.[host]?.Handlers;
          // Never remove a shared listener or any route other than this package's root proxy.
          if (Object.keys(config.Web ?? {}).length !== 1 || Object.keys(config.TCP ?? {}).length !== 1 ||
              Object.keys(config.TCP?.["443"] ?? {}).join() !== "HTTPS" || config.TCP["443"].HTTPS !== true ||
              !handlers || Object.keys(handlers).join() !== "/" || Object.keys(handlers["/"] ?? {}).join() !== "Proxy" ||
              handlers["/"].Proxy !== `http://127.0.0.1:${port}` || Object.values(config.AllowFunnel ?? {}).some(Boolean)) {
            res.writeHead(409).end("Serve configuration does not exclusively match Pi Pocket. Check it on the laptop.");
            return;
          }
          await execFileAsync("tailscale", ["serve", "--https=443", "off"], { timeout: 10000, maxBuffer: 1024 * 1024 });
          routeRemoved = true;
          remoteOrigin = undefined;
          await unlink(originFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          res.writeHead(200).end("Tailscale access turned off.");
        } catch (error) {
          ctx.ui.notify(`Pi Pocket could not finish disabling Tailscale access: ${error}`, "error");
          res.writeHead(500).end(routeRemoved ? "Serve is off, but Pi Pocket could not save its settings. Check the laptop." : "Could not turn off Tailscale Serve. Check the laptop.");
        } finally {
          disconnectingTailscale = false;
        }
      } else if (req.method === "POST" && (req.url === "/api/stop" || req.url === "/api/stop-all")) {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") {
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
            await mkdir(stateDir, { recursive: true, mode: 0o700 });
            await writeFile(disabledFile, "Pi Remote disabled. Use /remote enable to restart.\n", { mode: 0o600 });
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
        const prompt = queued.shift()!;
        try {
          pi.appendEntry("pi-pocket-prompt", { via: prompt.via });
          messages.push({ role: "source", via: prompt.via });
          pi.sendUserMessage(prompt.text);
        } catch (error) { queued.unshift(prompt); ctx.ui.notify(`Pi Remote could not send: ${error}`, "error"); }
      }
    }, 250);
    queueTimer.unref();
  }

  pi.on("session_start", async (_event, ctx) => {
    loadHistory(ctx.sessionManager.getBranch());
    try {
      const configured = await readFile(originFile, "utf8");
      if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(configured)) throw new Error("Invalid Tailscale origin");
      remoteOrigin = configured;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      remoteOrigin = undefined;
    }
    try {
      // Preserve an all-stop made by the older project-local extension.
      try {
        await readFile(join(ctx.cwd, ".pi", "remote-disabled"));
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(disabledFile, "Pi Remote disabled. Use /remote enable to restart.\n", { mode: 0o600 });
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
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
