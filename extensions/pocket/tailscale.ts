import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type Run = (args: string[]) => Promise<string>;

async function runTailscale(args: string[]) {
  const { stdout } = await execFileAsync("tailscale", args, { timeout: 10000, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** Configure only a private, unoccupied HTTPS listener, or reuse our existing route. */
export async function prepareTailscale(port: number, run: Run = runTailscale) {
  let status: any;
  try { status = JSON.parse(await run(["status", "--json"])); }
  catch { throw new Error("Cannot read Tailscale status. Install Tailscale and connect this laptop, then try again."); }
  const hostname = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  if (status?.BackendState !== "Running" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(hostname) || hostname.length > 253) {
    throw new Error("Tailscale is not connected or has no valid MagicDNS hostname. Check Tailscale on the laptop.");
  }
  const authority = `${hostname}:443`;
  const target = `http://127.0.0.1:${port}`;
  const readConfig = async () => {
    const parsed: unknown = JSON.parse(await run(["serve", "status", "--json"]));
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Invalid Tailscale Serve configuration.");
    return (parsed ?? {}) as { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
  };
  const isOurs = (config: Awaited<ReturnType<typeof readConfig>>) => config.TCP?.["443"]?.HTTPS === true && config.Web?.[authority]?.Handlers?.["/"]?.Proxy === target && !Object.values(config.AllowFunnel ?? {}).some(Boolean);
  const config = await readConfig();
  if (!isOurs(config)) {
    if (config.TCP?.["443"] || Object.keys(config.Web ?? {}).some((host) => host.endsWith(":443")) || Object.values(config.AllowFunnel ?? {}).some(Boolean)) {
      throw new Error("Tailscale Serve already has another route or Funnel configuration. Check it on the laptop; nothing was changed.");
    }
    try { await run(["serve", "--bg", "--https=443", target]); }
    catch (error: any) {
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const approval = output.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9_-]+/)?.[0];
      throw new Error(approval ? `Enable Tailscale Serve at ${approval}, then run /remote pair again.` : "Could not start Tailscale Serve. Check Tailscale and its Serve settings on the laptop.");
    }
    if (!isOurs(await readConfig())) throw new Error("Could not verify the Tailscale Serve route. Check Serve settings on the laptop.");
  }
  return `https://${hostname}`;
}
