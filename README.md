# Pi Pocket

A local web interface for viewing and prompting a running [Pi](https://github.com/earendil-works/pi) session. It is designed for mobile screens, but currently only accepts connections from the same computer.

## Setup

Install Node.js 24 or newer and Pi. Install Pi Pocket from Git:

```sh
pi install git:github.com/0Tarun0709/pi-pocket
```

Restart Pi or run `/reload`, then open **http://127.0.0.1:18789**. Run `/remote` to see the address. Only one Pi Pocket session can use the port at a time.

### Local development

Clone this repository, run `npm ci`, and start Pi in the repository. The project package is declared in `.pi/settings.json`; Pi loads it after project trust is granted. Use `/reload` after changes. If you already installed the package globally, disable one copy while developing to avoid a port conflict.

## Features

- View the current conversation, streaming responses, and expandable tool activity.
- Send prompts, change themes, and stop an active run from the composer.
- Use **Sessions → Stop all & disconnect** to abort the run, discard queued web prompts, and disable the web server. Run `/remote enable` in the laptop terminal to enable it again. The disabled state persists in `~/.pi/agent/pi-pocket/` (or under `PI_CODING_AGENT_DIR`) across package updates and projects. This does not undo actions already performed or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the web interface are not implemented. A notification appears when Pi is waiting for terminal input.

## Security

The server listens on loopback only; Tailscale and remote access are not configured. Do not expose it to the internet. Anyone who can access the interface can send prompts to your Pi agent and read its session. The all-stop control disables Pi Pocket, not Tailscale or other network access.

## Tests

```sh
npm test
npm run typecheck
```
