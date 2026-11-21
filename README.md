# PockPi

[![npm version](https://img.shields.io/npm/v/pockpi)](https://www.npmjs.com/package/pockpi)
[![Pi >1.0.0](https://img.shields.io/badge/Pi-%3E1.0.0-blue)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
[![Node.js 24 or newer](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Access your running [Pi](https://github.com/earendil-works/pi) session from a browser, locally or privately through Tailscale. View responses and tool activity, send prompts, and stop a running agent.

See the [changelog](CHANGELOG.md) for release history.

## Why I built this

I wanted a way to use the agent running on my laptop from my phone. When I'm
away and think of something it could fix or work on, I don't want to wait until
I get back to start it. PockPi lets me send a prompt, check on the progress, and
pick up where I left off when I return.

## Install

Requires Pi and Node.js 24 or newer.

```sh
pi install npm:pockpi
```

Alternatively, install from Git with `pi install git:github.com/0Tarun0709/pockpi`.

If upgrading from an earlier package, use `pi list` and remove the old package
with `pi remove <source>` to avoid a port conflict. Existing paired browsers and
emergency-stop settings are retained.

Restart Pi or run `/reload`. PockPi registers live sessions privately; browser access stays off until you request it.

## Use on your laptop

Run `/remote` in Pi, then open **http://127.0.0.1:18790** on the laptop. Local access does not require pairing.

## Use on your phone

1. Install Tailscale on both devices and connect them to the same tailnet.
2. Run `/remote pair` in Pi on the laptop.
3. Scan the QR code with your phone to pair its browser.

Your laptop must remain awake, online, and running Pi. PockPi starts or reuses a private Tailscale Serve route; it never enables Funnel. If Tailscale asks an administrator to enable Serve, follow the displayed link and run `/remote pair` again.

The QR code is a secret: it expires after two minutes, works once, and is invalidated when you generate another. If you can't scan it, press `c` to see the address and pairing code. Run `/remote devices` on the laptop to revoke a paired browser; its ID appears in the **More actions (…)** menu. Pairing lasts up to one year and is lost if the browser's data is cleared.

## Session controls

- **Model** lets you choose an available model when Pi is idle. It changes the current session, not your default for new sessions.
- **Stop execution** requests that Pi stop the current run without disconnecting.
- **More actions (…) → Turn off Tailscale access** disconnects devices using the PockPi Serve route. Pi keeps running, and any enabled local access stays available. Run `/remote pair` on the laptop to reconnect. If Serve is shared with another route, PockPi won't remove it automatically. If the phone disconnects before confirming success, check `tailscale serve status` on the laptop.
- **More actions (…) → Stop all & disconnect** requests cancellation in all shared sessions, discards queued PockPi prompts, and disables access persistently. On the laptop, run `/remote enable`, then `/remote` or `/remote pair` to start again. It cannot undo completed actions or immediately stop tools that ignore cancellation.

Run `/remote` once for local access, or `/remote pair` once for phone access. Tap the **Pi icon** to switch between all running sessions that have PockPi loaded under the same Pi user profile. New sessions appear automatically; saved sessions that aren't running do not. Prompts, model changes, and **Stop execution** apply to the selected session. Answer interactive Pi dialogs in the laptop terminal.

## Security

- The unauthenticated local listener is bound to `127.0.0.1:18790`. **Never proxy or expose this port.** Other processes on the laptop can access it.
- Tailscale access uses the separate, authenticated listener on port `18789`. Only `/remote pair` enables it. Keep pairing codes and paired devices private.
- Both ports are reserved while PockPi is running; an access method not enabled returns HTTP 503. The session that starts browser access hosts the gateway; other sessions register through private local sockets. Paired browsers can access all registered sessions. If the gateway session exits, rerun `/remote` or `/remote pair` in a remaining session.
- If HTTPS port 443 is already used by another service or Funnel is configured, PockPi refuses to change Serve. Check `tailscale serve status` on the laptop and avoid changing Serve settings concurrently while pairing.
- Browser credential hashes and the emergency lock are stored in Pi's agent data directory (`~/.pi/agent/`, or `PI_CODING_AGENT_DIR` if set). Device labels are browser-reported, not verified identities.

## Development

The web UI uses plain TypeScript and CSS in `web/`. The extension strips browser-side types at startup; there is no frontend build step or framework.

Clone the repository, run `npm ci`, and start Pi in the project directory. Grant project trust when prompted. The project package loads through `.pi/settings.json`; use `/reload` after changes. Disable a globally installed copy while developing to avoid a port conflict.

```sh
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
