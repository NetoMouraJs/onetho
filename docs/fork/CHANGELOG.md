# Onetho changelog

Onetho's own releases. Each one names the upstream (Alethe) code it is built on; what changed
upstream is in [`docs/CHANGELOG.md`](../CHANGELOG.md), kept as upstream writes it.

The in-app What's New panel reads the same releases from `src/lib/forkChangelog.ts`, with the notes
in every locale under `src/lib/i18n/messages/` (`whatsNew.fork.v<version>.note*`).

## [Unreleased]

## [0.1.0] - 2026-10-19

Upstream base: Alethe 1.7.0 plus upstream `main` up to `e684e72` (`v1.7.0-259-ge684e72`).

### Added

- Its own identity: the name Onetho, the `onetho` terminal command, the `com.netomoura.onetho`
  identifier, and updates from this repository's releases.
- Its own icon, the Open orbit ring, in the executable, the installer, the taskbar and the four
  options of the app icon picker. The workspace empty state and the default profile picture use it
  too.
- Its own version line, starting at 0.1.0, with release candidates (`0.1.0-rcNN`) before the tag.
  The What's New panel lists Onetho's releases first, each with its upstream base, then upstream's.

### Fixed

- A Claude session you named now shows that name.
- The sidebar resize handle shows whenever the resize cursor does.
