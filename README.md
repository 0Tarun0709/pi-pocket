# Pi Pocket

A web interface for viewing and prompting a running [Pi](https://github.com/earendil-works/pi) session. It listens on the laptop and can be accessed privately over Tailscale Serve.

## Setup

Install Node.js 24 or newer and Pi. Install Pi Pocket from Git:

```sh
pi install git:github.com/0Tarun0709/pi-pocket
```

Restart Pi or run `/reload`. Pi Pocket does not start a web server automatically. Run `/remote` in Pi to enable laptop access, then open **http://127.0.0.1:18790**; no pairing is needed. For your phone, connect both devices to Tailscale and run `/remote pair` in Pi; scan the QR code it displays. Codes expire after two minutes and can be used once. Only one Pi Pocket session can use the ports at a time.

### Local development

Clone this repository, run `npm ci`, and start Pi in the repository. The project package is declared in `.pi/settings.json`; Pi loads it after project trust is granted. Use `/reload` after changes. If you already installed the package globally, disable one copy while developing to avoid a port conflict.

## Features

- View the current conversation, streaming responses, and expandable tool activity.
- Send prompts, change themes, and stop an active run from the composer.
- Use **Sessions → Turn off Tailscale access** to disconnect all devices using the Pi Pocket Serve route without stopping Pi or local access. The button only removes an exclusive matching Serve configuration; if other routes share it, disable the route manually on the laptop.
- Use **Sessions → Stop all & disconnect** to abort the run, discard queued web prompts, and disable the web server. Run `/remote enable` in the laptop terminal to unlock it, then `/remote` or `/remote pair` to start access again. The disabled state persists in `~/.pi/agent/pi-pocket/` (or under `PI_CODING_AGENT_DIR`) across package updates and projects. This does not undo actions already performed or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the web interface are not implemented. A notification appears when Pi is waiting for terminal input.

## Tailscale access

Install Tailscale on both devices, sign in, and connect them to the same tailnet. Run `/remote pair` in Pi on the laptop. Pi Pocket discovers the laptop's Tailscale hostname, starts or reuses its private Serve route, and displays a QR code. Scan it with your phone to pair its browser.

The first time, Tailscale may require an administrator to enable Serve; follow the link displayed in Pi, then run `/remote pair` again. If HTTPS port 443 is already used by another service or Funnel is configured, Pi Pocket refuses to change the configuration; inspect `tailscale serve status` on the laptop. Avoid changing Serve settings concurrently while pairing. Pi Pocket never enables Funnel. If scanning doesn't work, press `c` in the pairing view and open the displayed address to enter the code manually.

The QR contains a secret: anyone who can scan it before it expires can pair. It expires after two minutes, works only once, and generating a new code invalidates the old one. Paired browsers remain authorized across server restarts for up to one year; clearing browser data requires pairing again. Run `/remote devices` in the laptop terminal to select and revoke a browser. The session menu shows this browser's ID to help match it; device labels are based on the browser's self-reported user agent, not verified identity.

To remove remote access, use the Tailscale button. It removes both the Serve route and Pi Pocket's allowed Tailscale origin. The phone connection can close before the button receives confirmation; check `tailscale serve status` on the laptop if unsure. To reconnect, run `/remote pair` again. A previously paired browser can use the same saved address without scanning again. After **Stop all & disconnect**, run `/remote enable` locally first; pairing does not bypass this safety lock.

Alternatively, manage Serve manually with `tailscale serve --https=443 off` and remove the allowed origin with `/remote unshare`. If other services use Serve, inspect its configuration first and avoid removing their routes.

## Security

Pi Pocket starts no listeners until a user runs `/remote` or `/remote pair`. Once started, both ports are reserved to keep a single Pi session in control; the address not explicitly enabled returns HTTP 503. Both bind to loopback. The laptop-only listener on port `18790` does not require pairing; other local processes can access it. The separate Tailscale listener on port `18789` requires a paired browser and is enabled by `/remote pair`, not by `/remote`. **Never proxy or expose port 18790.** A previously configured Tailscale Serve route may remain after Pi stops, but it has no running Pi Pocket server to reach. Pairing uses a 192-bit one-time code and a persistent browser credential; only a hash of that credential is stored in `~/.pi/agent/pi-pocket/browsers.json` (or under `PI_CODING_AGENT_DIR`). Remote cookies are HTTPS-only, HttpOnly, and SameSite=Strict. Host and request-origin checks apply to both listeners. Anyone with a pairing code or paired browser and network access can read the session and send prompts to Pi. Protect your laptop and paired devices, use Tailscale MFA, and restrict tailnet access. The all-stop control disables Pi Pocket, not Tailscale or other network access. It cannot undo completed actions.

## Tests

```sh
npm test
npm run typecheck
```
