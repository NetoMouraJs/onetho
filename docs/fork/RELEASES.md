# Onetho releases — milestones and release candidates

How a version of Onetho goes from a list of issues to a tagged installer. Onetho has its own version
line (from `0.1.0`); upstream's versions never carry over.

## The pieces

| Piece | What it is | Where |
|---|---|---|
| Issue | One per fix or change, in English: Symptom / Cause / Fix / Verification (or Goal / Steps for larger work), ending with `Backlog: ON-NN` | GitHub issues of `NetoMouraJs/onetho` |
| Milestone | One per version (`0.1.0`, `0.2.0`…), holding every issue that has to be closed before the version is tagged | GitHub milestones |
| Release candidate | Every installer built before the tag: `X.Y.Z-rc01`, `X.Y.Z-rc02`… (two digits), each with its tag `vX.Y.Z-rcNN` | `npm run release rc` |
| Final version | `X.Y.Z`, tagged `vX.Y.Z`, built once the milestone is empty | `npm run release final` |
| Release notes | What's New in the app and the fork changelog, both written for `X.Y.Z` (candidates show the notes of the version they lead to) | `src/lib/forkChangelog.ts`, `docs/fork/CHANGELOG.md` |

## 1. Plan the version: milestone and issues

Create the milestone once per version:

```powershell
gh api -X POST repos/NetoMouraJs/onetho/milestones -f title="0.2.0" -f state="open" `
  -f description="Onetho 0.2.0. Installers built before the tag are release candidates (0.2.0-rcNN)."
```

Put each issue that belongs to the version in it, when it is created or later:

```powershell
gh issue create -R NetoMouraJs/onetho --title "..." --label bug --milestone "0.2.0" --body-file issue.md
gh issue edit 12 -R NetoMouraJs/onetho --milestone "0.2.0"
gh issue list -R NetoMouraJs/onetho --milestone "0.2.0" --state all   # what the version holds
```

An issue that slips to a later version moves to that version's milestone.

## 2. Work on the issues

- Commit messages follow the repository's format (`fix(scope): …`, `chore(fork): …`) and name the
  issue: `Closes #N` when the commit finishes it, `Refs #N` when more is to come. After the push, the
  issue lists the commit in its timeline.
- An issue is closed as completed once the change is checked in an installed build, with a comment
  naming the commit.

## 3. Cut a release candidate

Whenever there is something to try in an installed build:

1. Make sure the version has notes. `src/lib/forkChangelog.ts` needs an entry for `X.Y.Z` (with its
   upstream base, see below) and its `whatsNew.fork.vXYZ.note*` keys in every locale under
   `src/lib/i18n/messages/`; `docs/fork/CHANGELOG.md` gets the same release. Commit them first.
2. Stamp the candidate, on a clean `main`:

   ```powershell
   npm run release 0.2.0-rc01      # the first candidate of a version
   npm run release rc              # the next one: 0.2.0-rc01 -> 0.2.0-rc02
   npm run release rc -- --dry-run # what it would do, without writing or pushing
   ```

   It writes the version into the five places it lives (`package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`), commits
   `chore(release): vX.Y.Z-rcNN`, creates the annotated tag and **pushes `main` and the tag**. It
   refuses to run with a dirty tree or without notes for `X.Y.Z`.
3. Build the installer from that commit (see [Local build](#local-build)). The file name carries the
   version: `Onetho_X.Y.Z-rcNN_x64-setup.exe`.
4. Install it and check the issues it was cut for; close the ones that work.

From an installed build back to its source: the version in Preferences → About gives the tag, and
the tag gives the commit. From an issue forward: the commits in its timeline; on GitHub, a commit's
page lists the tags that contain it.

## 4. Release the final version

When the milestone has no open issues left:

```powershell
npm run release final    # X.Y.Z-rcNN -> X.Y.Z, commit, tag vX.Y.Z, push
```

Build the installer from the tag, then close the milestone (on GitHub, or
`gh api -X PATCH repos/NetoMouraJs/onetho/milestones/<number> -f state=closed`).

Publishing the installers as a GitHub release with automatic updates (`npm run release:publish`)
waits for the fork's own updater key and for Actions on the fork (#6). The MSI that workflow builds
rejects versions with a suffix, so candidates stay local builds until then.

## Upstream base

Every release records the upstream code it is built on, in `forkChangelog.ts`
(`upstream: { version, commit }`) and in `docs/fork/CHANGELOG.md`:

```powershell
git fetch upstream
git describe --tags upstream/main    # e.g. v1.7.0-259-ge684e72 -> version 1.7.0, commit e684e72
```

Merge upstream before cutting a candidate when its changes should be in it (see "Syncing with
upstream" in the [README](README.md)).

## Local build

Windows, from the repository root, with the Visual Studio C++ tools installed. `vcvarsall.bat` needs
`vswhere.exe` on the `PATH`. Until the updater has the fork's own key (#6), the updater artifacts
have to be turned off, through a config file kept outside the repository:

```powershell
'{ "bundle": { "createUpdaterArtifacts": false } }' | Set-Content $env:USERPROFILE\onetho-local-build.json
$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\Installer;$env:PATH"
cmd /c "`"C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat`" >NUL && npm run tauri build -- --bundles nsis --config %USERPROFILE%\onetho-local-build.json"
```

The installer lands in `src-tauri\target\release\bundle\nsis\`. A `target` folder copied from another
path breaks the build (Tauri's build scripts keep absolute paths): run `cargo clean` in `src-tauri`
first.
