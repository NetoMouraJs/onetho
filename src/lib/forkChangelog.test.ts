import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json'
import { FORK_RELEASES } from './forkChangelog'

describe("Onetho's What's New releases", () => {
  it('cover the version being shipped', () => {
    expect(FORK_RELEASES.map((release) => release.version)).toContain(packageJson.version)
  })

  it('are listed newest first, once each', () => {
    const versions = FORK_RELEASES.map((release) => release.version)
    const newestFirst = [...versions].sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    )
    expect(versions).toEqual(newestFirst)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('each name the upstream release and commit they are built on', () => {
    for (const { upstream } of FORK_RELEASES) {
      expect(upstream.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(upstream.commit).toMatch(/^[0-9a-f]{7,40}$/)
    }
  })
})
