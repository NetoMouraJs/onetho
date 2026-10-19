# Onetho brand sources

The Onetho mark is the **Open orbit**: an open ring, a session you come back to and continue. These
SVGs are the sources; every bitmap the app ships is generated from them. The Alethe marks are not
licensed by the AGPL (`TRADEMARK.md`), so none of them is reused.

| File | What it is |
|---|---|
| `mark.svg` | The ring alone, one color, filled path (no strokes). |
| `app-icon-{original,pure-black,indigo,blush}.svg` | The ring on a rounded tile, in the four palettes of the app icon picker. Indigo is the default. |
| `wordmark.svg` | The ring as the "O" of "Onetho", the other letters drawn as paths (no font needed). |
| `installer-header.svg`, `installer-sidebar.svg` | NSIS layouts at their exact sizes (150×57, 164×314). |

## Palettes

| Option (id) | Tile | Ring |
|---|---|---|
| Elite Original (`elite-original`) | `#fcfcfb` | `#96a4f2` |
| Elite Pure Black (`elite-pure-black`) | `#000000` | `#f3f4f6` |
| Elite Indigo (`elite-indigo`, default) | `#0c0c0e` | `#6c5ff2` |
| Elite Blush (`elite-blush`) | `#fff7f2` | `#d4a184` |

The option ids and file names are upstream's, kept so stored preferences and code stay untouched.

## Where each source goes

| Target | From | How |
|---|---|---|
| `src-tauri/icons/*` (exe, installer, window, store logos) | `app-icon-indigo.svg` | `npx tauri icon docs/fork/brand/app-icon-indigo.svg` |
| `src/assets/theme-icons/elite-*.png` (220 px) and `32/`, `48/`, `64/` | `app-icon-*.svg` | `npx tauri icon <svg> -o <tmp> -p 220,32,48,64`, then copy each size |
| `src/assets/theme-icons/dark.png` (default profile picture) | `app-icon-indigo.svg` | the 220 px render |
| `src/assets/alethe-mark.svg` (workspace empty state, CSS mask) | `mark.svg` | copy |
| `src-tauri/installer/header.bmp`, `sidebar.bmp` | `installer-*.svg` | render at the exact size, save as 24-bit BMP |

## Not replaced yet

The other `src/assets/theme-icons/*` images and `alethe-logo.png`, `logo-loading.png` and
`alethe-loading-mark.png` are not shown anywhere in the app, but `themeIcons.ts` globs every PNG under
`theme-icons/*/`, so the 32/48/64 ones still ship in the bundle.
