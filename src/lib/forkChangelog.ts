import type { ChangelogRelease } from './changelogData'

/** The upstream code a fork release is built on: upstream's last release and the commit merged. */
export type UpstreamBase = {
  version: string
  commit: string
}

export type ForkRelease = ChangelogRelease & {
  upstream: UpstreamBase
}

/** Onetho's own releases, curated by hand, newest first. Upstream's list in `changelogData.ts` stays
 * as upstream keeps it; `npm run release` checks this one. Release candidates (X.Y.Z-rcNN) are not
 * listed: they show the notes of X.Y.Z. */
export const FORK_RELEASES: ForkRelease[] = [
  {
    version: '0.1.0',
    date: '2026-10-19',
    upstream: { version: '1.7.0', commit: 'e684e72' },
    noteKeys: ['whatsNew.fork.v010.note1', 'whatsNew.fork.v010.note2', 'whatsNew.fork.v010.note3'],
  },
]
