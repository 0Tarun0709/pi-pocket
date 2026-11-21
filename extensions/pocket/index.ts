import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Pairing } from "./auth.ts";
import { prepareTailscale } from "./tailscale.ts";
import { openSession, listSessions, sessionRequest, sessionDirectory, sessionId } from "./sessions.ts";

const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const require = createRequire(import.meta.url);
const QRCode: typeof import("qrcode") = require("qrcode");
const execFileAsync = promisify(execFile);
const port = 18789;
const localPort = 18790;
// Preserve existing security state and the emergency lock across renames.
const stateDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-pocket");
const disabledFile = join(stateDir, "remote-disabled");
const originFile = join(stateDir, "tailscale-origin");
const directory = sessionDirectory(stateDir);

export type ToolMessage = { role: "tool"; id: string; name: string; args: unknown; output?: unknown; startedAt?: number; endedAt?: number; state: "running" | "done" | "error" | "unknown" };
export type TextMessage = { role: "user" | "assistant"; text: string };
export type DisplayMessage = TextMessage | { role: "source"; via: "tailscale" | "local" } | ToolMessage;

function display(message: any): DisplayMessage | undefined {
  if (message?.role !== "user" && message?.role !== "assistant") return;
  const text = typeof message.content === "string" ? message.content :
    message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  if (text) return { role: message.role as "user" | "assistant", text };
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let localServer: Server | undefined;
  let shared: Awaited<ReturnType<typeof openSession>> | undefined;
  let messages: DisplayMessage[] = [];
  let streaming: DisplayMessage | undefined;
  let waiting: { kind: string; title?: string } | undefined;
  let disabled = false;
  let queued: { text: string; via: "tailscale" | "local" }[] = [];
  let queueTimer: ReturnType<typeof setInterval> | undefined;
  let pairing = new Pairing(stateDir);
  let remoteOrigin: string | undefined;
  let disconnectingTailscale = false;
  let sessionActive = false;
  let generation = 0;
  let localEnabled = false;
  let remoteEnabled = false;
  let starting = false;
  let changingModel = false;

  function stopServer() {
    generation++;
    localEnabled = false;
    remoteEnabled = false;
    if (queueTimer) clearInterval(queueTimer);
    queueTimer = undefined;
    shared?.close();
    shared = undefined;
    const active = [server, localServer];
    server = undefined;
    localServer = undefined;
    for (const listener of active) if (listener) { listener.close(); listener.closeAllConnections(); }
  }

  async function ensureEnabled() {
    if (!sessionActive || disabled) throw new Error("PockPi is disabled. Use /remote enable first.");
    try {
      await readFile(disabledFile);
      disabled = true;
      stopServer();
      throw new Error("PockPi is disabled. Use /remote enable first.");
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
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
          if (part.type === "toolCall") messages.push({ role: "tool", id: part.id, name: part.name, args: part.arguments, startedAt: message.timestamp, state: "unknown" });
        }
      } else if (message.role === "toolResult") {
        const existing = tool(message.toolCallId);
        if (existing) Object.assign(existing, { output: { content: message.content, details: message.details }, endedAt: message.timestamp, state: message.isError ? "error" : "done" });
        else messages.push({ role: "tool", id: message.toolCallId, name: message.toolName, args: undefined, output: { content: message.content, details: message.details }, state: message.isError ? "error" : "done" });
      }
    }
    streaming = undefined;
    waiting = undefined;
  }

  pi.registerEntryRenderer("pi-pocket-prompt", (entry, _options, theme) => {
    const label = (entry.data as { via?: string } | undefined)?.via === "tailscale"
      ? "↳ PockPi · Tailscale address"
      : "↳ PockPi · local address";
    return { render: (width: number) => [theme.fg("dim", label.slice(0, Math.max(0, width)))], invalidate() {} };
  });

  pi.registerCommand("remote", {
    description: "Show the local address; use /remote pair for Tailscale access",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "pair" || input === "pair local") {
        if (!sessionActive) { ctx.ui.notify("PockPi is not available in this session.", "error"); return; }
        if (disabled) { ctx.ui.notify("PockPi is disabled. Use /remote enable first.", "error"); return; }
        let origin: string | undefined;
        let reserved = false;
        try {
          await ensureEnabled();
          await startServer(ctx, false, false);
          reserved = true;
          if (input === "pair") remoteEnabled = false;
          const startingGeneration = generation;
          if (input === "pair") {
            ctx.ui.notify("Preparing private Tailscale access…", "info");
            origin = await prepareTailscale(port);
            if (!sessionActive || disabled || generation !== startingGeneration) throw new Error("PockPi stopped during setup.");
            await mkdir(stateDir, { recursive: true, mode: 0o700 });
            await writeFile(originFile, origin, { mode: 0o600 });
            if (!sessionActive || disabled || generation !== startingGeneration) throw new Error("PockPi stopped during setup.");
            remoteOrigin = origin;
          }
          await startServer(ctx, false);
          const address = server?.address();
          if (!address || typeof address === "string") throw new Error("PockPi is not running.");
          origin ??= `http://127.0.0.1:${address.port}`;
        } catch (error) {
          if (reserved && !localEnabled && !remoteEnabled) stopServer();
          ctx.ui.notify(`PockPi could not start pairing: ${error}\nCheck Tailscale Serve on the laptop before retrying.`, "error");
          return;
        }
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
            const addressLines: string[] = [];
            const addressWidth = Math.max(1, width - 9);
            for (let i = 0; i < origin.length; i += addressWidth) addressLines.push(`${i ? "         " : "Address: "}${origin.slice(i, i + addressWidth)}`.slice(0, width));
            const fits = width >= size && height >= rows.length + 1;
            if (fits && !showCode) {
              const title = origin.startsWith("https://") ? "Scan QR · c: code · Esc: close · expires in 2 min" : "Local pairing · c: code · Esc: close · expires in 2 min";
              return [theme.fg("accent", title.slice(0, width)), ...rows, ...(height >= rows.length + codeLines.length + addressLines.length + 2 ? [...codeLines, ...addressLines, "Enter or Esc to close".slice(0, width)] : [])];
            }
            return [theme.fg("accent", "Pairing code · expires in 2 minutes".slice(0, width)), ...codeLines, ...addressLines, (fits ? "c: QR · Esc: close" : "Enlarge terminal for QR · Esc: close").slice(0, width)];
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
        if (!owner?.listening) { ctx.ui.notify("PockPi is not running in this session. Manage browsers in the session that owns the server.", "error"); return; }
        const browsers = pairing.list();
        if (!browsers.length) { ctx.ui.notify("No paired browsers.", "info"); return; }
        const options = browsers.map((browser) => `${browser.label} · ${browser.id} · paired ${browser.created.slice(0, 10)}`);
        const selected = await ctx.ui.select("Select a browser to revoke", options);
        const index = selected ? options.indexOf(selected) : -1;
        if (index >= 0 && await ctx.ui.confirm("Revoke browser?", `This will disconnect ${options[index]}.`)) {
          if (server !== owner || !owner.listening) { ctx.ui.notify("PockPi stopped; browser was not revoked.", "error"); return; }
          pairing.revoke(browsers[index].id);
          ctx.ui.notify("Browser revoked.", "info");
        }
        return;
      }
      if (input === "unshare") {
        try {
          await unlink(originFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          remoteOrigin = undefined;
          ctx.ui.notify("PockPi no longer accepts the Tailscale hostname. Disable Tailscale Serve separately.", "info");
        } catch (error) { ctx.ui.notify(`PockPi could not remove its origin: ${error}`, "error"); }
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
          ctx.ui.notify(`PockPi accepts ${remoteOrigin}. Run /remote pair to pair a browser.`, "info");
        } catch (error) { ctx.ui.notify(`PockPi could not save its origin: ${error}`, "error"); }
        return;
      }
      if (input === "enable") {
        try {
          await unlink(join(ctx.cwd, ".pi", "remote-disabled")).catch((error) => { if (error.code !== "ENOENT") throw error; });
          await unlink(disabledFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          disabled = false;
          ctx.ui.notify("PockPi enabled. Use /remote for local access or /remote pair for Tailscale.", "info");
        } catch (error) { ctx.ui.notify(`PockPi could not enable: ${error}`, "error"); }
        return;
      }
      if (input) { ctx.ui.notify("Use /remote for local access, /remote pair for Tailscale, or /remote devices to manage browsers.", "info"); return; }
      if (disabled) { ctx.ui.notify("PockPi is disabled. Use /remote enable first.", "error"); return; }
      try { await startServer(ctx, true); }
      catch (error) { ctx.ui.notify(`PockPi could not start: ${error}`, "error"); return; }
      const address = localServer?.address();
      ctx.ui.notify(address && typeof address !== "string" ? `PockPi is available at http://127.0.0.1:${address.port}\nUse /remote pair for Tailscale access.` : "Session added to the existing PockPi gateway. Open Sessions on your connected device.", "info");
    },
  });

  async function startServer(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, isLocal: boolean, activate = true) {
    await ensureEnabled();
    const startingGeneration = generation;
    if (starting) throw new Error("PockPi is already starting. Try again.");
    if (server && localServer) {
      if (activate) {
        if (isLocal) localEnabled = true; else remoteEnabled = true;
        const address = (isLocal ? localServer : server).address();
        if (address && typeof address !== "string") ctx.ui.notify(`${isLocal ? "PockPi local" : "PockPi"}: http://127.0.0.1:${address.port}`, "info");
      }
      return;
    }
    starting = true;
    try { await startListeners(ctx, isLocal, startingGeneration, activate); }
    finally { starting = false; }
  }

  async function startListeners(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, isLocal: boolean, startingGeneration: number, activate: boolean) {
    pairing = new Pairing(stateDir);
    const assets = new Map(Object.entries({
      "/app.css": join(webDir, "app.css"),
      "/app.js": join(webDir, "app.ts"),
      "/transcript.js": join(webDir, "transcript.ts"),
      "/pair.js": join(webDir, "pair.ts"),
      "/marked.js": join(dirname(require.resolve("marked")), "marked.umd.js"),
      "/purify.js": join(dirname(require.resolve("dompurify")), "purify.min.js"),
      "/highlight.js": require.resolve("@highlightjs/cdn-assets/highlight.min.js"),
    }));
    const [html, pairPage, assetBodies] = await Promise.all([
      readFile(join(webDir, "index.html")),
      readFile(join(webDir, "pair.html")),
      Promise.all([...assets].map(async ([url, path]) => [url, path.endsWith(".ts") ? stripTypeScriptTypes(await readFile(path, "utf8")) : await readFile(path)] as const)),
    ]);
    const staticFiles = new Map(assetBodies);
    const availableModels = () => {
      const available = ctx.modelRegistry.getAvailable();
      const scoped = ctx.scopedModels;
      return scoped?.length ? available.filter(model => scoped.some(({ model: entry }) => entry.provider === model.provider && entry.id === model.id)) : available;
    };
    const handler = (isLocal: boolean, internal = false) => async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      const url = (req.url ?? "").split("?", 1)[0];
      if (internal && req.method === "POST" && url === "/internal/stop-all") {
        if (!existsSync(disabledFile)) { res.writeHead(403).end(); return; }
        disabled = true;
        queued = [];
        res.once("finish", stopServer);
        ctx.abort();
        res.writeHead(204).end();
        return;
      }
      if (internal && (!shared || !sessionActive || disabled || existsSync(disabledFile))) { res.writeHead(503).end(); return; }
      const info = () => ({ name: ctx.sessionManager.getSessionName?.() || (shared && !localServer ? basename(ctx.cwd) : "Current session"), project: basename(ctx.cwd), busy: !ctx.isIdle(), waiting: Boolean(waiting), gateway: Boolean(server?.listening) });
      if (internal && req.method === "GET" && url === "/internal/info") { res.writeHead(200).end(JSON.stringify(info())); return; }
      if (internal && !/^(GET \/api\/(session|models)|POST \/api\/(prompt|stop|model))$/.test(`${req.method} ${url}`)) { res.writeHead(404).end(); return; }
      const host = req.headers.host;
      const address = (isLocal ? localServer : server)?.address();
      const expectedHost = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
      const localOrigin = `http://${expectedHost}`;
      const requestOrigin = internal ? "http://localhost" : host === expectedHost ? localOrigin : !isLocal && remoteOrigin && host === new URL(remoteOrigin).host ? remoteOrigin : undefined;
      if (!requestOrigin || (req.headers.origin && req.headers.origin !== requestOrigin)) {
        res.writeHead(403).end();
        return;
      }
      if (!internal && (disabled || existsSync(disabledFile) || (isLocal ? !localEnabled : !remoteEnabled))) { res.writeHead(503).end("PockPi is not active for this address."); return; }
      res.setHeader("Cache-Control", "no-store");
      const cookieName = requestOrigin === localOrigin ? "pi-pocket-local" : "__Host-pi-pocket";
      const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const browser = internal ? undefined : pairing.identify(cookie);
      if (!isLocal && req.method === "POST" && req.url === "/api/pair") {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 1024) { res.writeHead(413).end(); return; } }
        if (disabled || !remoteEnabled || existsSync(disabledFile) || (requestOrigin !== localOrigin && requestOrigin !== remoteOrigin)) { res.writeHead(503).end(); return; }
        try {
          const token = pairing.accept(JSON.parse(body).code, req.headers["user-agent"]);
          if (!token) { res.writeHead(401).end("Invalid or expired pairing code."); return; }
          res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${requestOrigin === localOrigin ? "" : "; Secure"}`);
          res.writeHead(200).end();
        } catch (error) {
          ctx.ui.notify(`PockPi pairing failed: ${error}`, "error");
          res.writeHead(400).end("Could not complete pairing. Generate a new code on the laptop.");
        }
        return;
      }
      if (req.method === "GET" && (url === "/" || url === "/pair")) {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(isLocal || (browser && url === "/") ? html : pairPage);
      } else if (!internal && req.method === "GET" && url === "/pair.js") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(staticFiles.get(url));
      } else if (!internal && !isLocal && !browser) {
        res.writeHead(401).end("Pair this browser using /remote pair on the laptop.");
      } else if (!internal && req.method === "GET" && url === "/api/sessions") {
        const sessions = await listSessions(directory);
        if (disabled || existsSync(disabledFile) || (!isLocal && (!pairing.identify(cookie) || (requestOrigin !== localOrigin && requestOrigin !== remoteOrigin)))) { res.writeHead(503).end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(sessions));
      } else if (!internal && /^\/api\/sessions\//.test(url)) {
        const [, , , id, action, extra] = url.split("/");
        if (extra !== undefined || !sessionId.test(id) || !/^(GET (session|models)|POST (prompt|stop|model))$/.test(`${req.method} ${action}`)) { res.writeHead(404).end(); return; }
        let body: string | undefined;
        if (req.method === "POST") {
          if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
          const limit = action === "prompt" ? 64_000 : 4096;
          const requestGeneration = generation;
          body = "";
          for await (const chunk of req) { body += chunk; if (body.length > limit) { res.writeHead(413).end(); return; } }
          if (disabled || existsSync(disabledFile) || generation !== requestGeneration || (isLocal ? !localEnabled : !remoteEnabled || !pairing.identify(cookie) || (requestOrigin !== localOrigin && requestOrigin !== remoteOrigin))) { res.writeHead(503).end(); return; }
        }
        const outgoing = sessionRequest(directory, id, `/api/${action}`, req.method, {
          origin: "http://localhost", "content-type": "application/json", "x-pockpi-via": !isLocal && requestOrigin === remoteOrigin ? "tailscale" : "local",
        });
        outgoing.on("response", upstream => {
          if (action === "session" && upstream.statusCode === 200) {
            void (async () => {
              try {
                const chunks = [];
                for await (const chunk of upstream) chunks.push(chunk);
                const session = JSON.parse(Buffer.concat(chunks).toString());
                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...session, local: isLocal, browser }));
              } catch { if (!res.headersSent) res.writeHead(502).end(); }
            })();
          } else {
            res.writeHead(upstream.statusCode ?? 502, { "Content-Type": upstream.headers["content-type"] ?? "text/plain" });
            upstream.on("error", () => res.destroy());
            upstream.pipe(res);
          }
        });
        outgoing.on("error", () => { if (!res.headersSent) res.writeHead(404).end("Session is no longer available."); else res.destroy(); });
        res.on("close", () => outgoing.destroy());
        outgoing.end(body);
      } else if (req.method === "GET" && staticFiles.has(url)) {
        const type = url.endsWith(".css") ? "text/css" : "text/javascript";
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }).end(staticFiles.get(url));
      } else if (req.method === "GET" && req.url === "/api/session") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          messages: streaming ? [...messages, streaming] : messages,
          busy: !ctx.isIdle(),
          waiting,
          queued: queued.length,
          browser,
          local: isLocal,
          name: info().name,
          project: info().project,
          id: shared?.id,
          model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name },
        }));
      } else if (req.method === "GET" && req.url === "/api/models") {
        const models = availableModels().map(({ provider, id, name }) => ({ provider, id, name }));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(models));
      } else if (req.method === "POST" && req.url === "/api/model") {
        if (req.headers.origin !== requestOrigin || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
        const requestGeneration = generation;
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
        let selection;
        try { selection = JSON.parse(body); } catch { res.writeHead(400).end("Invalid model selection."); return; }
        if (typeof selection?.provider !== "string" || typeof selection?.id !== "string") { res.writeHead(400).end("Invalid model selection."); return; }
        if (disabled || existsSync(disabledFile) || generation !== requestGeneration || (!internal && ((isLocal ? !localEnabled : !remoteEnabled) || (!isLocal && (!pairing.identify(cookie) || (requestOrigin !== localOrigin && requestOrigin !== remoteOrigin)))))) {
          res.writeHead(503).end("Access is no longer active."); return;
        }
        if (changingModel || waiting || queued.length || !ctx.isIdle()) { res.writeHead(409).end("Wait for Pi to finish before changing models."); return; }
        const model = availableModels().find(model => model.provider === selection.provider && model.id === selection.id);
        if (!model) { res.writeHead(404).end("This model is not available in this session."); return; }
        changingModel = true;
        try {
          if (await pi.setModel(model)) res.writeHead(204).end();
          else res.writeHead(409).end("This model's provider is not signed in.");
        } catch {
          res.writeHead(500).end("Pi could not change models.");
        } finally { changingModel = false; }
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
          if (disabled || !sessionActive || existsSync(disabledFile) || (internal ? !shared : isLocal ? !localEnabled : !remoteEnabled || !pairing.identify(cookie) || (requestOrigin !== localOrigin && requestOrigin !== remoteOrigin))) { res.writeHead(503).end("PockPi access is no longer active."); return; }
          queued.push({ text: text.trim(), via: (internal ? req.headers["x-pockpi-via"] === "tailscale" : !isLocal && requestOrigin === remoteOrigin) ? "tailscale" : "local" });
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
            res.writeHead(409).end("Serve configuration does not exclusively match PockPi. Check it on the laptop.");
            return;
          }
          await execFileAsync("tailscale", ["serve", "--https=443", "off"], { timeout: 10000, maxBuffer: 1024 * 1024 });
          routeRemoved = true;
          remoteOrigin = undefined;
          await unlink(originFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
          res.writeHead(200).end("Tailscale access turned off.");
        } catch (error) {
          ctx.ui.notify(`PockPi could not finish disabling Tailscale access: ${error}`, "error");
          res.writeHead(500).end(routeRemoved ? "Serve is off, but PockPi could not save its settings. Check the laptop." : "Could not turn off Tailscale Serve. Check the laptop.");
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
            const sessions = await listSessions(directory);
            await writeFile(disabledFile, "PockPi disabled. Use /remote enable to restart.\n", { mode: 0o600 });
            await Promise.all(sessions.filter(({ id }) => id !== shared?.id).map(({ id }) => new Promise<void>(resolve => {
              const request = sessionRequest(directory, id, "/internal/stop-all", "POST");
              request.once("response", response => { response.resume(); resolve(); });
              request.once("error", () => resolve());
              request.end();
            })));
            res.writeHead(200).end();
          } catch (error) {
            ctx.ui.notify(`PockPi disabled, but could not persist the lock: ${error}`, "error");
            res.writeHead(500).end("Disabled until restart, but could not save the lock");
          }
        } else {
          ctx.abort();
          res.writeHead(200).end();
        }
      } else {
        res.writeHead(404).end();
      }
    };
    if (!sessionActive || disabled || generation !== startingGeneration) throw new Error("PockPi stopped during startup.");
    const startWorker = async () => {
      if (shared) return;
      const worker = await openSession(directory, (req, res) => { void handler(false, true)(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }); });
      if (!sessionActive || disabled || existsSync(disabledFile) || generation !== startingGeneration) { worker.close(); throw new Error("PockPi stopped during startup."); }
      shared = worker;
    };
    const handle = (isLocal: boolean) => {
      const route = handler(isLocal);
      return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        void route(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); });
      };
    };
    server = createServer(handle(false));
    localServer = createServer(handle(true));
    const remote = server, local = localServer;
    for (const listener of [remote, local]) listener.on("error", (error) => ctx.ui.notify(`PockPi: ${error.message}`, "error"));
    try {
      for (const [listener, listenPort] of [[remote, port], [local, localPort]] as const) {
        await new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(listenPort, "127.0.0.1", () => resolve());
        });
      }
      await ensureEnabled();
      if (!sessionActive || disabled || generation !== startingGeneration || server !== remote || localServer !== local) throw new Error("PockPi stopped during startup.");
    } catch (error) {
      for (const listener of [remote, local]) { listener.close(); listener.closeAllConnections(); }
      server = localServer = undefined;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const gateway = (await listSessions(directory)).find(session => session.gateway);
      if (!gateway) throw error;
      if (!isLocal || !activate) throw new Error("Run /remote pair in the Pi session hosting the PockPi gateway.");
    }
    try { await startWorker(); } catch (error) { stopServer(); throw error; }
    if (activate && server) { if (isLocal) localEnabled = true; else remoteEnabled = true; }
    const address = (isLocal ? local : remote).address();
    if (activate && address && typeof address !== "string") ctx.ui.notify(`${isLocal ? "PockPi local" : "PockPi"}: http://127.0.0.1:${address.port}`, "info");
    if (!queueTimer) queueTimer = setInterval(() => {
      if (!disabled && existsSync(disabledFile)) { disabled = true; queued = []; stopServer(); ctx.abort(); return; }
      if (!disabled && !changingModel && queued.length && ctx.isIdle()) {
        const prompt = queued.shift()!;
        try {
          pi.appendEntry("pi-pocket-prompt", { via: prompt.via });
          messages.push({ role: "source", via: prompt.via });
          pi.sendUserMessage(prompt.text);
        } catch (error) { queued.unshift(prompt); ctx.ui.notify(`PockPi could not send: ${error}`, "error"); }
      }
    }, 250);
    queueTimer.unref();
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    generation++;
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
        await writeFile(disabledFile, "PockPi disabled. Use /remote enable to restart.\n", { mode: 0o600 });
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      await readFile(disabledFile);
      disabled = true;
      ctx.ui.notify("PockPi disabled. Use /remote enable to restart.", "info");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      disabled = false;
    }
  });

  pi.on("session_tree", async (_event, ctx) => { loadHistory(ctx.sessionManager.getBranch()); });
  pi.on("ui_prompt_start", async (event) => { waiting = { kind: event.kind, title: event.title }; });
  pi.on("ui_prompt_end", async () => { waiting = undefined; });
  pi.on("tool_execution_start", async (event) => {
    messages.push({ role: "tool", id: event.toolCallId, name: event.toolName, args: event.args, startedAt: Date.now(), state: "running" });
  });
  pi.on("tool_execution_update", async (event) => {
    const item = tool(event.toolCallId);
    if (item) item.output = event.partialResult;
  });
  pi.on("tool_execution_end", async (event) => {
    const item = tool(event.toolCallId);
    if (item) Object.assign(item, { output: event.result, endedAt: Date.now(), state: event.isError ? "error" : "done" });
  });
  pi.on("message_update", async (event) => { streaming = display(event.message); });
  pi.on("message_end", async (event) => {
    const item = display(event.message);
    if (item) messages.push(item);
    if (event.message.role === "assistant") streaming = undefined;
  });
  pi.on("session_shutdown", async () => {
    sessionActive = false;
    queued = [];
    stopServer();
  });
}
