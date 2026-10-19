import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Checkouts with core.autocrlf=true have CRLF line endings; the parsing below expects LF.
function readWorkflow(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

const ciWorkflow = readWorkflow('.github/workflows/ci.yml')
const releaseWorkflow = readWorkflow('.github/workflows/release.yml')

function jobBlocks(workflow: string): string[] {
  const lines = workflow.split('\n')
  const jobsIndex = lines.findIndex((line) => line === 'jobs:')
  const blocks: string[] = []
  let current: string[] | null = null

  for (const line of lines.slice(jobsIndex + 1)) {
    if (/^\s{2}[A-Za-z0-9_-]+:$/.test(line)) {
      if (current) blocks.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }

  if (current) blocks.push(current.join('\n'))
  return blocks
}

function jobName(block: string): string {
  return block.split('\n')[0].trim().replace(/:$/, '')
}

/** A job's `needs`, written as one name or as a `[a, b]` list. */
function jobNeeds(block: string): string[] {
  const value = block.match(/^\s{4}needs: (.+)$/m)?.[1]?.trim()
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

describe('release workflow quality gate', () => {
  it('keeps CI event triggers while allowing release to call it', () => {
    expect(ciWorkflow).toMatch(/^\s{2}push:$/m)
    expect(ciWorkflow).toMatch(/^\s{2}pull_request:$/m)
    expect(ciWorkflow).toMatch(/^\s{2}workflow_call:$/m)
  })

  it('gates every Tauri publishing job on the reusable CI workflow', () => {
    const blocks = jobBlocks(releaseWorkflow)
    const qualityJob = blocks.find((block) => block.startsWith('  quality:'))
    const publishingJobs = blocks.filter((block) => block.includes('tauri-apps/tauri-action'))

    expect(qualityJob).toContain('uses: ./.github/workflows/ci.yml')
    expect(publishingJobs).not.toHaveLength(0)

    for (const job of publishingJobs) {
      expect(job).toMatch(/^\s{4}needs: quality$/m)
      expect(job).toMatch(/^\s{4}permissions:\n\s{6}contents: write$/m)
      expect(job).toContain('secrets.GITHUB_TOKEN')
      expect(job).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY')
      expect(job).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    }

    expect(qualityJob).not.toContain('permissions:')
    expect(qualityJob).not.toContain('secrets.')

    // Jobs after the build edit the release it created, so they may write to it, but they never
    // see the signing key and none of them starts before the gate: each waits on the gate, or on a
    // job that does.
    const others = blocks.filter((block) => block !== qualityJob && !publishingJobs.includes(block))
    const gated = new Set(['quality', ...publishingJobs.map(jobName)])
    for (let grew = true; grew;) {
      grew = false
      for (const job of others) {
        if (!gated.has(jobName(job)) && jobNeeds(job).some((need) => gated.has(need))) {
          gated.add(jobName(job))
          grew = true
        }
      }
    }
    for (const job of others) {
      expect([...gated], jobName(job)).toContain(jobName(job))
      expect(job).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
    }
  })
})
