import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Browser = { id: string; hash: string; created: string; expires: number; label: string };
const lifetime = 365 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class Pairing {
  private readonly file: string;
  private readonly dir: string;
  private browsers: Browser[];
  private pending?: { code: string; expires: number };

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "browsers.json");
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(value) || !value.every((item) => item && /^[a-f0-9]{16}$/.test(item.id) && /^[a-f0-9]{64}$/.test(item.hash) && typeof item.created === "string" && Number.isSafeInteger(item.expires))) throw new Error("Invalid paired browsers file");
      this.browsers = value;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.browsers = [];
    }
  }

  private save(browsers: Browser[]) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = join(this.dir, `.browsers-${randomBytes(12).toString("hex")}`);
    try {
      writeFileSync(temporary, JSON.stringify(browsers), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
      this.browsers = browsers;
    } finally {
      try { unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }

  issue() {
    this.pending = { code: randomBytes(24).toString("base64url"), expires: Date.now() + 120_000 };
    return this.pending.code;
  }

  accept(code: unknown, userAgent = "") {
    const pending = this.pending;
    if (typeof code !== "string" || !pending || Date.now() >= pending.expires) return undefined;
    const given = Buffer.from(code);
    const expected = Buffer.from(pending.code);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    this.pending = undefined;
    const token = randomBytes(32).toString("base64url");
    const created = new Date().toISOString();
    const label = /iPhone|iPad/i.test(userAgent) ? "iPhone or iPad" : /Android/i.test(userAgent) ? "Android" : /Macintosh/i.test(userAgent) ? "Mac" : /Windows/i.test(userAgent) ? "Windows" : /Linux/i.test(userAgent) ? "Linux" : "Unknown";
    const browser = { id: randomBytes(8).toString("hex"), hash: digest(token), created, expires: Date.now() + lifetime, label };
    this.save([...this.browsers.filter((item) => item.expires > Date.now()), browser]);
    return token;
  }

  identify(token: string | undefined) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = digest(token);
    const browser = this.browsers.find((item) => item.expires > Date.now() && item.hash === hash);
    return browser ? this.describe(browser) : undefined;
  }

  private describe({ id, created, label }: Browser) {
    return { id, created, label: typeof label === "string" && /^(iPhone or iPad|Android|Mac|Windows|Linux|Unknown)$/.test(label) ? label : "Unknown" };
  }

  list() { return this.browsers.filter((browser) => browser.expires > Date.now()).map((browser) => this.describe(browser)); }

  revoke(id: string) { this.save(this.browsers.filter((browser) => browser.id !== id)); }
}
