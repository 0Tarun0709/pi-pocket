# Pi Pocket

A web interface for viewing and prompting a running [Pi](https://github.com/earendil-works/pi) session. It listens on the laptop and can be accessed privately over Tailscale Serve.

## Setup

Install Node.js 24 or newer and Pi. Install Pi Pocket from Git:

```sh
pi install git:github.com/0Tarun0709/pi-pocket
```

Restart Pi or run `/reload`, then open **http://127.0.0.1:18789**. Run `/remote pair` in Pi and enter the displayed code in the browser. Codes expire after two minutes and can be used once. Only one Pi Pocket session can use the port at a time.

### Local development

Clone this repository, run `npm ci`, and start Pi in the repository. The project package is declared in `.pi/settings.json`; Pi loads it after project trust is granted. Use `/reload` after changes. If you already installed the package globally, disable one copy while developing to avoid a port conflict.

## Features

- View the current conversation, streaming responses, and expandable tool activity.
- Send prompts, change themes, and stop an active run from the composer.
- Use **Sessions → Turn off Tailscale access** to disconnect all devices using the Pi Pocket Serve route without stopping Pi or local access. The button only removes an exclusive matching Serve configuration; if other routes share it, disable the route manually on the laptop.
- Use **Sessions → Stop all & disconnect** to abort the run, discard queued web prompts, and disable the web server. Run `/remote enable` in the laptop terminal to enable it again. The disabled state persists in `~/.pi/agent/pi-pocket/` (or under `PI_CODING_AGENT_DIR`) across package updates and projects. This does not undo actions already performed or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the web interface are not implemented. A notification appears when Pi is waiting for terminal input.

## Tailscale access

Install Tailscale on both devices, sign in, and connect them to the same tailnet. In Pi, run `/reload`. Verify the loaded server requires authentication before configuring any proxy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/api/session
```

The result **must be `401`**. If not, do not enable Serve: check which Pi instance owns the port and reload it. Find the Mac's full `Self.DNSName` with `tailscale status --json`, then run `/remote share <hostname>` in Pi using its exact `*.ts.net` hostname (no scheme or trailing dot). This configures an allowed HTTPS origin; it does not enable Tailscale Serve. In the Mac terminal, enable private Serve:

```sh
tailscale serve --bg 18789
```

Follow Tailscale's instructions if HTTPS needs enabling. With your phone connected to Tailscale, run `/remote pair` in Pi on the laptop and scan the QR code. It opens Pi Pocket and pairs that browser. If scanning doesn't work, open the HTTPS URL from `tailscale serve status` and enter the code shown in the terminal. Never use Funnel for Pi Pocket.

The QR contains a secret: anyone who can scan it before it expires can pair. It expires after two minutes, works only once, and generating a new code invalidates the old one. Paired browsers remain authorized across server restarts for up to one year; clearing browser data requires pairing again. Run `/remote devices` in the laptop terminal to select and revoke a browser. The session menu shows this browser's ID to help match it; device labels are based on the browser's self-reported user agent, not verified identity.

To remove remote access, use the Tailscale button. It removes both the Serve route and Pi Pocket's allowed Tailscale origin. The phone connection can close before the button receives confirmation; check `tailscale serve status` on the laptop if unsure. To reconnect, run `/remote share <hostname>` in Pi and `tailscale serve --bg 18789` in the laptop terminal.

Alternatively, manage Serve manually with `tailscale serve --https=443 off` and remove the allowed origin with `/remote unshare`. If other services use Serve, inspect its configuration first and avoid removing their routes.

## Security

The server listens on loopback only and requires a paired browser even locally, including when reached through a proxy. Pairing uses a 192-bit one-time code and a persistent browser credential; only a hash of that credential is stored in `~/.pi/agent/pi-pocket/browsers.json` (or under `PI_CODING_AGENT_DIR`). Remote cookies are HTTPS-only, HttpOnly, and SameSite=Strict. The configured hostname and request origin are checked; only the configured Tailscale HTTPS origin and local origin are accepted. Anyone with a pairing code or paired browser and network access can read the session and send prompts to Pi. Protect your laptop and paired devices, use Tailscale MFA, and restrict tailnet access. The all-stop control disables Pi Pocket, not Tailscale or other network access. It cannot undo completed actions.

## Tests

```sh
npm test
npm run typecheck
```
