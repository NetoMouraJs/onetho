# Onetho — fork notes

Onetho is a fork of [Alethe](https://github.com/Kc1t/alethe-agents) (Kauã Miguel), under the same
**AGPL-3.0-or-later** licence. The Alethe trademark is not licensed by the AGPL (`TRADEMARK.md`), so
the fork has its own name, identifier and icons.

This folder belongs to the fork alone — upstream never touches it, so it never causes merge
conflicts. It starts with this README and grows as needed: when a topic outgrows a section, it gets
its own file here and a line in this index.

## Identity

| | Value | Where |
|---|---|---|
| Name | `Onetho` | `src/lib/brand.ts`, `src-tauri/src/brand.rs` |
| Terminal command | `onetho` | same |
| Identifier | `com.netomoura.onetho` (dev: `com.netomoura.onetho.dev`) | same + `src-tauri/tauri.conf.json`, `tauri.dev.json` |
| Repository | `NetoMouraJs/alethe-agents` | `src/lib/brand.ts`, `plugin_catalog.rs`, `tauri.conf.json` (updater) |

Translated texts are **not** edited: `translate()` (`src/lib/i18n/index.ts`) swaps "Alethe" for
"Onetho" at runtime, and the remote UI does the same in `src-tauri/remote/app.js`.

## Rules that keep merges cheap

1. **Do not rename internal identifiers**: `ALETHE_*`, `alethe:*` keys, `alethe://` events,
   `alethe-plugin:`, `window.alethe`, `.alethe/`, the `alethe_*` MCP tools, the `alethe_lib` crate.
2. **Do not edit translation files or upstream docs** to change the brand — use `brand.ts`.
3. **Keep rebrand commits separate** from features and fixes.
4. **Generic improvements go upstream first** (issue/PR on Kc1t). Once accepted, the fork no longer
   has to carry them. Those PRs follow upstream's own rules in `AGENTS.md`: English only, a
   `docs/CHANGELOG.md` entry, and a `docs/MAC_PORT.md` entry with a `Mac-Port:` trailer.

## Syncing with upstream

```powershell
git fetch --unshallow                       # once: the initial clone has a single commit
git remote add upstream https://github.com/Kc1t/alethe-agents.git
git remote set-url --push upstream no-push  # never push to upstream by accident
git config rerere.enabled true              # remembers resolutions of repeated conflicts
git fetch upstream
git merge upstream/main                     # merge, not rebase (public fork)
```
