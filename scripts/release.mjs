#!/usr/bin/env node
/**
 * Version bump + commit + tag + push. Does NOT publish installers.
 *
 * Keeps the four sources of the version in sync:
 *   package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml · src-tauri/Cargo.lock (alethe entry)
 *
 * Usage:
 *   npm run release            # patch:  1.2.0 -> 1.2.1
 *   npm run release minor      #         1.2.0 -> 1.3.0
 *   npm run release major      #         1.2.0 -> 2.0.0
 *   npm run release 1.5.0      # explicit version
 *   npm run release -- --dry-run   # show what it would do, without writing or pushing
 *
 * Refuses to run when the in-app What's New panel has no notes for the new version.
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

// 2) Current version (source: package.json).
const pkgRaw = readFileSync(PKG, 'utf8')
const cur = pkgRaw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/)
if (!cur) fail(`Version not found in ${PKG}`)
const [major, minor, patch] = cur.slice(1).map(Number)
const current = `${major}.${minor}.${patch}`

// 3) Next version.
let next
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg
else if (bumpArg === 'major') next = `${major + 1}.0.0`
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`
else if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`
else fail(`Invalid bump: "${bumpArg}". Use: patch | minor | major | X.Y.Z`)

const tag = `v${next}`
console.log(`\n  ${current}  →  ${next}   (tag ${tag})\n`)

// 4) The What's New panel is curated by hand, so a version stamped without notes ships a panel
//    that stops at the previous release (1.6.0 and 1.7.0 both did). Checked before anything is
//    written; the notes land in their own commit ahead of the bump.
const whatsNew = readFileSync(WHATS_NEW, 'utf8')
const listed = [...whatsNew.matchAll(/version:\s*'(\d+\.\d+\.\d+)'/g)].map((m) => m[1])
if (!listed.includes(next)) {
  fail(
    `What's New has no notes for ${next} (newest listed: ${listed[0] ?? 'none'}).\n` +
      `  Add a { version: '${next}', upstream, ... } entry at the top of ${WHATS_NEW}, with its\n` +
      `  whatsNew.fork.v${next.replaceAll('.', '')}.note* keys in every locale under src/lib/i18n/messages/,\n` +
      '  commit it, then run the release again.',
  )
}

// 5) Rewrite the version (first occurrence) in each file.
function bumpFile(path, regex, label = path) {
  const raw = readFileSync(path, 'utf8')
  const m = raw.match(regex)
  if (!m) fail(`Version not found in ${path}`)
  const updated = raw.replace(regex, (full) => full.replace(m[1], next))
  console.log(`  ~ ${label}  (${m[1]} → ${next})`)
  if (!dryRun) writeFileSync(path, updated)
}
bumpFile(PKG, /"version":\s*"(\d+\.\d+\.\d+)"/)
bumpFile(TAURI, /"version":\s*"(\d+\.\d+\.\d+)"/)
bumpFile(CARGO, /version\s*=\s*"(\d+\.\d+\.\d+)"/)

// Cargo.lock: only the entry of the crate itself (name = "alethe").
const toAdd = [PKG, TAURI, CARGO]
if (existsSync(LOCK)) {
  bumpFile(LOCK, /name = "alethe"\r?\nversion = "(\d+\.\d+\.\d+)"/, LOCK)
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
