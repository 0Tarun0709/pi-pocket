# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-11-21

### Added

- Switch between running Pi sessions and optionally show session tabs with live status.
- Change the selected session's model from the browser while Pi is idle.
- See elapsed time and thinking status alongside inline tool activity, without
  exposing reasoning text. Fold activity or jump to the latest message.

### Changed

- **Breaking:** One `/remote` or `/remote pair` now covers all running sessions
  with PockPi loaded under the same Pi profile. Paired browsers can access all
  of those sessions; individual sessions no longer opt in. Reload already-open
  Pi sessions once to pick up the change. Phone access still requires pairing.
- Split the web UI into plain TypeScript and CSS and tighten the mobile layout.

## [0.1.5] - 2026-11-21

### Added

- Explain the motivation behind PockPi in the README.

### Changed

- Use PockPi branding in documentation while preserving existing security state.

## [0.1.4] - 2026-11-21

### Changed

- Rename the project to PockPi and publish as `pockpi` on npm.
- Preserve existing paired browsers and emergency-stop state.

## [0.1.3] - 2026-11-21

### Changed

- Rename the project and publish the renamed package on npm.
- Preserve existing paired browsers and emergency-stop state during the rename.

## [0.1.2] - 2026-11-21

### Added

- GitHub Actions workflow for staging npm releases with trusted publishing and
  maintainer approval.

## [0.1.1] - 2026-11-21

### Added

- npm installation.
- A changelog included in the package.

## [0.1.0] - 2026-11-21

### Added

- Browser interface for a running Pi session, with streamed responses, Markdown,
  themes, and expandable tool activity.
- On-demand laptop access with `/remote` and private phone access with
  `/remote pair` through Tailscale Serve.
- Short-lived QR pairing codes, persistent browser credentials, and individual
  browser revocation.
- Controls to stop execution, disconnect Tailscale access, or perform an
  emergency stop and disable remote access.
- Installable Pi package, setup and security documentation, and MIT license.

[Unreleased]: https://github.com/0Tarun0709/pockpi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/0Tarun0709/pockpi/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/0Tarun0709/pockpi/compare/480ff3f...v0.1.5
[0.1.4]: https://github.com/0Tarun0709/pockpi/compare/6364ed9...480ff3f
[0.1.3]: https://github.com/0Tarun0709/pockpi/compare/v0.1.2...6364ed9
[0.1.2]: https://github.com/0Tarun0709/pockpi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/0Tarun0709/pockpi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0Tarun0709/pockpi/tree/v0.1.0
