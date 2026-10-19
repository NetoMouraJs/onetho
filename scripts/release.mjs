#!/usr/bin/env node
/**
 * Version bump + commit + tag + push. Does NOT publish installers.
 *
 * Keeps the five sources of the version in sync:
 *   package.json · package-lock.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml ·
 *   src-tauri/Cargo.lock (alethe entry)
 *
 * Usage:
 *   npm run release            # patch:  1.2.0 -> 1.2.1
 *   npm run release minor      #         1.2.0 -> 1.3.0
 *   npm run release major      #         1.2.0 -> 2.0.0
 *   npm run release 1.5.0      # explicit version
 *   npm run release rc         # next release candidate: 1.2.0-rc01 -> 1.2.0-rc02 (from 1.2.0: 1.2.1-rc01)
 *   npm run release final      # release candidate to final: 1.2.0-rc02 -> 1.2.0
 *   npm run release 1.3.0-rc01 # explicit release candidate
 *   npm run release -- --dry-run   # show what it would do, without writing or pushing
 *
 * Refuses to run when the in-app What's New panel has no notes for the new version (a release
 * candidate needs the notes of its final version).
 *
 * Pushing the tag does NOT trigger a build (release.yml only runs through workflow_dispatch).
 * To publish the installers afterwards: npm run release:publish
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bumpArg = args.find((a) => !a.startsWith('--')) ?? 'patch'

const PKG = 'package.json'
const PKG_LOCK = 'package-lock.json'
const TAURI = 'src-tauri/tauri.conf.json'
const CARGO = 'src-tauri/Cargo.toml'
const LOCK = 'src-tauri/Cargo.lock'
// The fork's own list; upstream's (src/lib/changelogData.ts) never holds the fork's versions.
const WHATS_NEW = 'src/lib/forkChangelog.ts'

function sh(cmd) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim()
}
function run(cmd) {
  console.log(`  $ ${cmd}`)
  if (!dryRun) execSync(cmd, { stdio: 'inherit' })
}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// 1) Clean tree — the release commit may contain the bump and nothing else.
const dirty = sh('git status --porcelain')
if (dirty) fail(`Working tree is dirty. Commit or discard before releasing:\n${dirty}`)

// A version is X.Y.Z, or X.Y.Z-rcNN for a release candidate (two digits, so they sort as text too).
const VERSION = String.raw`\d+\.\d+\.\d+(?:-rc\d{2})?`
const rcLabel = (n) => `rc${String(n).padStart(2, '0')}`

// 2) Current version (source: package.json).
const pkgRaw = readFileSync(PKG, 'utf8')
const cur = pkgRaw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)(?:-rc(\d{2}))?"/)
if (!cur) fail(`Version not found in ${PKG}`)
const [major, minor, patch] = cur.slice(1, 4).map(Number)
const rc = cur[4] ? Number(cur[4]) : null
const base = `${major}.${minor}.${patch}`
const current = rc ? `${base}-${rcLabel(rc)}` : base

// 3) Next version.
let next
if (new RegExp(`^${VERSION}$`).test(bumpArg)) next = bumpArg
else if (bumpArg === 'major') next = `${major + 1}.0.0`
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`
else if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`
else if (bumpArg === 'rc') {
  if (rc && rc >= 99) fail(`${current} is the last release candidate the two-digit format allows`)
  next = rc ? `${base}-${rcLabel(rc + 1)}` : `${major}.${minor}.${patch + 1}-${rcLabel(1)}`
} else if (bumpArg === 'final') {
  if (!rc) fail(`${current} is not a release candidate`)
  next = base
} else fail(`Invalid bump: "${bumpArg}". Use: patch | minor | major | rc | final | X.Y.Z[-rcNN]`)
// A release candidate shows the notes of the version it leads to.
const notesVersion = next.replace(/-rc\d{2}$/, '')

const tag = `v${next}`
console.log(`\n  ${current}  →  ${next}   (tag ${tag})\n`)

// 4) The What's New panel is curated by hand, so a version stamped without notes ships a panel
//    that stops at the previous release (1.6.0 and 1.7.0 both did). Checked before anything is
//    written; the notes land in their own commit ahead of the bump.
const whatsNew = readFileSync(WHATS_NEW, 'utf8')
const listed = [...whatsNew.matchAll(/version:\s*'(\d+\.\d+\.\d+)'/g)].map((m) => m[1])
if (!listed.includes(notesVersion)) {
  fail(
    `What's New has no notes for ${notesVersion} (newest listed: ${listed[0] ?? 'none'}).\n` +
      `  Add a { version: '${notesVersion}', upstream, ... } entry at the top of ${WHATS_NEW}, with its\n` +
      `  whatsNew.fork.v${notesVersion.replaceAll('.', '')}.note* keys in every locale under src/lib/i18n/messages/,\n` +
      '  commit it, then run the release again.',
  )
}

// 5) Rewrite the version (first occurrence) in each file.
function bumpFile(path, regex, label = path) {
  const raw = readFileSync(path, 'utf8')
  // Read the first match without the global flag, so the capture group comes back.
  const m = raw.match(new RegExp(regex.source, regex.flags.replace('g', '')))
  if (!m) fail(`Version not found in ${path}`)
  // A global regex rewrites every match (package-lock.json holds the version twice).
  const updated = raw.replace(regex, (full, found) => full.replace(found, next))
  console.log(`  ~ ${label}  (${m[1]} → ${next})`)
  if (!dryRun) writeFileSync(path, updated)
}
bumpFile(PKG, new RegExp(`"version":\\s*"(${VERSION})"`))
bumpFile(TAURI, new RegExp(`"version":\\s*"(${VERSION})"`))
bumpFile(CARGO, new RegExp(`version\\s*=\\s*"(${VERSION})"`))

// package-lock.json: the root and the "" package, both right after the package name.
const toAdd = [PKG, TAURI, CARGO]
if (existsSync(PKG_LOCK)) {
  const name = JSON.parse(pkgRaw).name
  bumpFile(PKG_LOCK, new RegExp(`"name":\\s*"${name}",\\s*"version":\\s*"(${VERSION})"`, 'g'))
  toAdd.push(PKG_LOCK)
}

// Cargo.lock: only the entry of the crate itself (name = "alethe").
if (existsSync(LOCK)) {
  bumpFile(LOCK, new RegExp(`name = "alethe"\\r?\\nversion = "(${VERSION})"`), LOCK)
  toAdd.push(LOCK)
}

// 6) Commit + annotated tag + push (commit and tag), without triggering a release.
const branch = sh('git rev-parse --abbrev-ref HEAD')
run(`git add ${toAdd.join(' ')}`)
run(`git commit -m "chore(release): ${tag}"`)
run(`git tag -a ${tag} -m "${tag}"`)
run(`git push origin ${branch}`)
run(`git push origin ${tag}`)

console.log(`\n✓ ${tag} committed, tagged and pushed (branch ${branch}).`)
console.log('  This did NOT publish installers — it only stamped the version in git.')
console.log('  To publish the release: npm run release:publish')
if (dryRun) console.log('\n(dry-run: nothing was written or pushed)')
console.log('')
