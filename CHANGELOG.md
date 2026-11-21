# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.3] - 2026-11-21

### Changed

- Rename Pi Pocket to Pi Aevin and publish as `pi-aevin` on npm.
- Preserve existing paired browsers and emergency-stop state during the rename.

## [0.1.2] - 2026-11-21

### Added

- GitHub Actions workflow for staging npm releases with trusted publishing and
  maintainer approval.

## [0.1.1] - 2026-11-21

### Added

- npm installation as `@0tarun0709/pi-pocket`.
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
  emergency stop and disable Pi Pocket.
- Installable Pi package, setup and security documentation, and MIT license.

[Unreleased]: https://github.com/0Tarun0709/pi-aevin/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/0Tarun0709/pi-aevin/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/0Tarun0709/pi-aevin/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/0Tarun0709/pi-aevin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0Tarun0709/pi-aevin/releases/tag/v0.1.0
