# Releasing Alethe

Two deliberate steps, never one. `npm run release` only stamps a version in git; publishing
installers is a separate command. A pushed tag never builds anything on its own.

## Where the version lives

One version, four files, kept in sync by `scripts/release.mjs`:

| File                        | Why it matters                                     |
| --------------------------- | -------------------------------------------------- |
| `package.json`              | Source of truth the script reads the current version from |
| `src-tauri/tauri.conf.json` | The version the installers and `latest.json` carry  |
| `src-tauri/Cargo.toml`      | The crate version                                   |
| `src-tauri/Cargo.lock`      | The `alethe` entry only                             |

Never bump them by hand — the script rewrites all four and refuses to run on a dirty tree, so the
release commit contains the bump and nothing else.

## Before stamping: the macOS port ledger

The macOS app is a separate Swift codebase, so each release also closes its list of changes to
port. Before `npm run release`:

1. `npm run mac-port -- --check` passes, so every portable commit since the last Mac sync has an
   entry in `docs/MAC_PORT.md`.
2. Entries under **Unreleased** in `docs/MAC_PORT.md` move to a new `## <version>` section, with
   every sha filled in.

## Step 1 — stamp the version

```bash
npm run release              # patch: 1.7.0 -> 1.7.1
npm run release minor        #        1.7.0 -> 1.8.0
npm run release major        #        1.7.0 -> 2.0.0
npm run release 1.9.3        # explicit version
npm run release -- --dry-run # show what it would do, write nothing
```

It commits `chore(release): vX.Y.Z`, creates an annotated tag, and pushes both the branch and the
tag. No installer is built and no GitHub Release appears yet.

The script stops before writing anything when `src/lib/changelogData.ts` has no entry for the new
version. That list feeds the in-app **What's New** panel and is curated by hand, so its notes are
written and committed ahead of the bump (see below).

## Step 2 — publish the installers

```bash
npm run release:publish        # dispatch on the current branch
npm run release:publish -- main
```

This dispatches the **Release** workflow (`gh workflow run release.yml`), which builds four bundles
— Windows x64, Linux x64, macOS Apple Silicon, macOS Intel — and creates the GitHub Release from
the version in `tauri.conf.json`. Requires an authenticated `gh` CLI. Follow it with `gh run watch`
or Actions → Release.

Two jobs run after the build:

- **Publish the release notes** replaces the generic release body with `docs/releases/<tag>.md`
  (see below). A version with no notes file keeps the placeholder and logs a warning instead of
  failing the release.
- **Point windows-x86_64 at NSIS** rewrites `latest.json` so the generic Windows updater key serves
  the NSIS installer. This is not cosmetic: an MSI applied over an NSIS install neither upgrades it
  nor restarts the app, so the updater would close Alethe and nothing would come back. The job then
  verifies every platform is present and signed before it finishes.

## Release notes

Every version gets one file, `docs/releases/v<version>.md`, written **before** the release is
published — it goes through review like any other change. Its body becomes the GitHub Release body
verbatim, so write it for someone reading the release page, not for someone reading a diff:

- Lead with what changed for the user, grouped by area, not by commit.
- Say plainly whether upgrading is safe and what, if anything, moved.
- Keep the exhaustive entry-by-entry list in `docs/CHANGELOG.md` and link to it at the end.

`docs/CHANGELOG.md` is the other half: every feature addition, change or removal is recorded under
`[Unreleased]` in the same task that makes it. At release time `[Unreleased]` becomes the dated
version section and a fresh empty `[Unreleased]` goes back on top.

### In-app What's New

The panel behind the newspaper button reads `src/lib/changelogData.ts`: one entry per release,
newest first, each a short list of `whatsNew.v<version>.note<n>` keys translated in every locale
file. Add the entry for the version you are about to stamp in its own commit, before
`npm run release`. The list may run one release ahead of `package.json` in that window — the panel
title follows the build version, not the list — and `npm test` fails a build whose version has no
entry.

## Signing

The build **fails** without `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
in the repo secrets, because `bundle.createUpdaterArtifacts` is on. Generate the pair with
`npm run tauri signer generate` and register it once.

## Checklist

1. `npm test`, `npx tsc --noEmit` and `cd src-tauri && cargo test` are green.
2. `docs/CHANGELOG.md` has the dated version section and an empty `[Unreleased]`.
3. `docs/releases/v<version>.md` exists and reads well on its own.
4. `src/lib/changelogData.ts` has the entry for the version, translated in every locale.
5. Working tree clean, on the branch you mean to release from.
6. `npm run release <bump>` → `npm run release:publish` → watch the run.
7. Open the published release and confirm the notes, the four installers and `latest.json`.
