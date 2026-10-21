# Onetho changelog

Onetho's own releases. Each one names the upstream (Alethe) code it is built on; what changed
upstream is in [`docs/CHANGELOG.md`](../CHANGELOG.md), kept as upstream writes it.

The in-app What's New panel reads the same releases from `src/lib/forkChangelog.ts`, with the notes
in every locale under `src/lib/i18n/messages/` (`whatsNew.fork.v<version>.note*`).

## [Unreleased]

### Added

- A local Dev diagnostics dashboard records Claude and Codex usage refresh attempts and frontend failures with safe metadata, correlation IDs, filters and JSON export.
- Error rows in Dev diagnostics now expand to show their event details and a sanitized frontend stack when available.
- Codex usage updates on every Codex turn, read from the session files Codex already writes, so the
  card no longer waits for the next poll and the API is asked less often. The card says whether its
  reading came from a session or the API, and how old it is.
- Claude usage updates after every response in a Claude terminal Onetho starts, read from the rate
  limits Claude Code passes to its status line, so the card no longer depends on the usage API,
  which often refuses requests. A status line of your own keeps working and shows the same output.
  The card says whether its reading came from a session or the API, and how old it is.

### Changed

- Claude and Codex usage is asked from their APIs every 10 minutes instead of every 5, since the
  sessions push every change in between. Kimi is polled every 5 minutes instead of every minute,
  like Antigravity. A manual refresh still asks right away.

### Fixed

- Pane headers and sidebar rows now show the same name: a session named with `/rename` comes first,
  then a name you gave the pane or tab, then the automatic title. A late `/rename` is picked up, and
  leaked system reminder text no longer appears as a title.
- Onetho no longer keeps hitting the Claude usage service while it rate limits. The orchestrator
  reads usage through the shared cache instead of once a minute per pane, requests are at least
  30 seconds apart, and after a refusal no request goes out until a backoff that grows from one
  minute to fifteen ends, even across restarts. The card says it is rate limited and when it will
  try next, its refresh button stays off until then, a reading kept from before is marked as the
  last reading, and a spinner shows while a read is on its way.

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
