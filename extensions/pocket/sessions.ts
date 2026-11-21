import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "node:net";
import { join, resolve } from "node:path";

export type SharedSession = { id: string; name: string; project: string; busy: boolean; waiting: boolean; gateway: boolean };
export const sessionId = /^[a-f0-9]{24}$/;

export function sessionDirectory(stateDir: string) {
  return `/tmp/pockpi-${createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 24)}`;
}

async function checkDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Unsafe PockPi session directory.");
}

export async function openSession(directory: string, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await checkDirectory(directory);
  const id = randomBytes(12).toString("hex");
  const socket = join(directory, id);
  const server = createServer(handler);
  // Use a private socket, never a second browser-accessible listener.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    Server.prototype.listen.call(server, { path: socket }, resolve);
  });
  return { id, close() { server.close(); server.closeAllConnections(); } };
}

export function sessionRequest(directory: string, id: string, path: string, method = "GET", headers = {}) {
  const outgoing = request({ socketPath: join(directory, id), path, method, headers, agent: false });
  outgoing.setTimeout(10_000, () => outgoing.destroy());
  return outgoing;
}

export async function listSessions(directory: string): Promise<SharedSession[]> {
  const ids = await checkDirectory(directory).then(() => readdir(directory)).catch((error) => { if (error.code !== "ENOENT") throw error; return []; });
  const sessions = await Promise.all(ids.filter(id => sessionId.test(id)).map(id => new Promise<SharedSession | undefined>(resolve => {
    const outgoing = sessionRequest(directory, id, "/internal/info");
    outgoing.setTimeout(1000, () => outgoing.destroy());
    outgoing.on("response", async res => {
      try {
        let body = "";
        for await (const chunk of res) { body += chunk; if (body.length > 8192) throw new Error(); }
        if (res.statusCode !== 200) { resolve(undefined); return; }
        resolve({ ...JSON.parse(body), id });
      } catch { resolve(undefined); }
    });
    outgoing.on("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") void unlink(join(directory, id)).catch(() => {});
      resolve(undefined);
    });
    outgoing.end();
  })));
  return sessions.filter((session): session is SharedSession => Boolean(session)).sort((a, b) => Number(b.gateway) - Number(a.gateway) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
