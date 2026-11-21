# Pi Pocket

A local web interface for viewing and prompting a running [Pi](https://github.com/badlogic/pi-mono) session. It is designed for mobile screens, but currently only accepts connections from the same computer.

## Setup

Install Node.js 24 or newer and Pi. From this directory:

```sh
npm ci
pi
```

Pi loads the project extension automatically. In an already running session, use `/reload`. Open **http://127.0.0.1:18789**, or run `/remote` to see the address.

## Features

- View the current conversation, streaming responses, and expandable tool activity.
- Send prompts, change themes, and stop an active run from the composer.
- Use **Sessions → Stop all & disconnect** to abort the run, discard queued web prompts, and disable the web server. Run `/remote enable` in the laptop terminal to enable it again. This does not undo actions already performed or immediately stop tools that ignore cancellation.

Session switching and answering Pi's interactive dialogs from the web interface are not implemented. A notification appears when Pi is waiting for terminal input.

## Security

The server listens on loopback only; Tailscale and remote access are not configured. Do not expose it to the internet. Anyone who can access the interface can send prompts to your Pi agent and read its session. The all-stop control disables Pi Pocket, not Tailscale or other network access.

## Tests

```sh
npm test
```
