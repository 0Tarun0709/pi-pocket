# Pi Pocket

[![Project version](https://img.shields.io/github/package-json/v/0Tarun0709/pi-pocket?label=version)](package.json)
[![Node.js 24 or newer](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Access your running [Pi](https://github.com/earendil-works/pi) session from a browser, locally or privately through Tailscale. View responses and tool activity, send prompts, and stop a running agent.

## Install

Requires Pi and Node.js 24 or newer.

```sh
pi install git:github.com/0Tarun0709/pi-pocket
```

Restart Pi or run `/reload`. Pi Pocket does not start a server until you request access.

## Use on your laptop

Run `/remote` in Pi, then open **http://127.0.0.1:18790** on the laptop. Local access does not require pairing.

## Use on your phone

1. Install Tailscale on both devices and connect them to the same tailnet.
2. Run `/remote pair` in Pi on the laptop.
3. Scan the QR code with your phone to pair its browser.

Your laptop must remain awake, online, and running Pi. Pi Pocket starts or reuses a private Tailscale Serve route; it never enables Funnel. If Tailscale asks an administrator to enable Serve, follow the displayed link and run `/remote pair` again.

The QR code is a secret: it expires after two minutes, works once, and is invalidated when you generate another. If you can't scan it, press `c` to see the address and pairing code. Run `/remote devices` on the laptop to revoke a paired browser; its ID appears in the Sessions menu. Pairing lasts up to one year and is lost if the browser's data is cleared.

## Session controls

- **Stop execution** requests that Pi stop the current run without disconnecting.
- **Sessions → Turn off Tailscale access** disconnects devices using the Pi Pocket Serve route. Pi keeps running, and any enabled local access stays available. Run `/remote pair` on the laptop to reconnect. If Serve is shared with another route, Pi Pocket won't remove it automatically. If the phone disconnects before confirming success, check `tailscale serve status` on the laptop.
- **Sessions → Stop all & disconnect** aborts the run, discards queued Pi Pocket prompts, and disables the server persistently. On the laptop, run `/remote enable`, then `/remote` or `/remote pair` to start again. It cannot undo completed actions or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the browser are not yet supported. Answer those dialogs in the laptop terminal.

## Security

- The unauthenticated local listener is bound to `127.0.0.1:18790`. **Never proxy or expose this port.** Other processes on the laptop can access it.
- Tailscale access uses the separate, authenticated listener on port `18789`. Only `/remote pair` enables it. Keep pairing codes and paired devices private.
- Both ports are reserved while Pi Pocket is running; an access method not enabled returns HTTP 503. Only one Pi session can use them at a time.
- If HTTPS port 443 is already used by another service or Funnel is configured, Pi Pocket refuses to change Serve. Check `tailscale serve status` on the laptop and avoid changing Serve settings concurrently while pairing.
- Browser credential hashes and the emergency lock are stored under `~/.pi/agent/pi-pocket/`, or `PI_CODING_AGENT_DIR` if set. Device labels are browser-reported, not verified identities.

## Development

Clone the repository, run `npm ci`, and start Pi in the project directory. Grant project trust when prompted. The project package loads through `.pi/settings.json`; use `/reload` after changes. Disable a globally installed copy while developing to avoid a port conflict.

```sh
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
