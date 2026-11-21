# Pi Pocket

A local web interface for viewing and prompting a running [Pi](https://github.com/earendil-works/pi) session. It is designed for mobile screens, but currently only accepts connections from the same computer.

## Setup

Install Node.js 24 or newer and Pi. Install Pi Pocket from Git:

```sh
pi install git:github.com/0Tarun0709/pi-pocket
```

Restart Pi or run `/reload`, then open **http://127.0.0.1:18789**. Run `/remote` in Pi for the username and access key. The key changes when the server restarts; keep it private. Only one Pi Pocket session can use the port at a time.

### Local development

Clone this repository, run `npm ci`, and start Pi in the repository. The project package is declared in `.pi/settings.json`; Pi loads it after project trust is granted. Use `/reload` after changes. If you already installed the package globally, disable one copy while developing to avoid a port conflict.

## Features

- View the current conversation, streaming responses, and expandable tool activity.
- Send prompts, change themes, and stop an active run from the composer.
- Use **Sessions → Stop all & disconnect** to abort the run, discard queued web prompts, and disable the web server. Run `/remote enable` in the laptop terminal to enable it again. The disabled state persists in `~/.pi/agent/pi-pocket/` (or under `PI_CODING_AGENT_DIR`) across package updates and projects. This does not undo actions already performed or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the web interface are not implemented. A notification appears when Pi is waiting for terminal input.

## Tailscale access

Install Tailscale on both devices, sign in, and connect them to the same tailnet. In Pi, run `/reload`, then `/remote` for the access key. Verify the loaded server requires authentication before configuring any proxy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/api/session
```

The result **must be `401`**. If not, do not enable Serve: check which Pi instance owns the port and reload it. Find the Mac's full `Self.DNSName` with `tailscale status --json`, then run `/remote share <hostname>` in Pi using its exact `*.ts.net` hostname (no scheme or trailing dot). This configures an allowed HTTPS origin; it does not enable Tailscale Serve. In the Mac terminal, enable private Serve:

```sh
tailscale serve --bg 18789
```

Follow Tailscale's instructions if HTTPS needs enabling. Open the HTTPS URL shown by `tailscale serve status` on your phone, and enter username `pocket` and the access key from `/remote`. The phone must be connected to Tailscale. Never use Funnel for Pi Pocket.

To remove remote access, run `tailscale serve --https=443 off` in the Mac terminal and `/remote unshare` in Pi. The latter removes the allowed origin but does not change Serve settings. If other services use Serve, inspect `tailscale serve status` first and avoid removing their configuration.

## Security

The server listens on loopback only and requires the access key even locally, including when reached through a proxy. The configured hostname and request origin are checked; only the configured Tailscale HTTPS origin and local origin are accepted. Anyone with the key and network access can read the session and send prompts to Pi. Keep the key private, use MFA, and restrict tailnet access. The all-stop control disables Pi Pocket, not Tailscale or other network access. It cannot undo completed actions.

## Tests

```sh
npm test
npm run typecheck
```
