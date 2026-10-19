import { Newspaper } from 'lucide-react'
import type { ReactNode } from 'react'

import { UPSTREAM_NAME } from '../../lib/brand'
import {
  CHANGELOG_RELEASES,
  type ChangelogRelease,
  CURRENT_VERSION,
  formatReleaseDate,
} from '../../lib/changelogData'
import { FORK_RELEASES } from '../../lib/forkChangelog'
import { intlLocale, useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './WhatsNewModal.module.css'

export function WhatsNewModal() {
  const t = useT()
  const locale = useProjectsStore((s) => s.preferences.language)
  const open = useUiStore((s) => s.openModal === 'whatsNew')
  const closeModal = useUiStore((s) => s.closeModal)
  const openModal = useUiStore((s) => s.openModal_)
  const updateInfo = useUiStore((s) => s.updateInfo)
  if (!open) return null

  const version = updateInfo?.version ?? updateInfo?.currentVersion ?? CURRENT_VERSION
  const hasUpdate = Boolean(updateInfo && updateInfo.version !== updateInfo.currentVersion)
  const dateLocale = intlLocale(locale)

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('whatsNew.title', { version })}
      width={480}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('whatsNew.close')}
          </button>
          {hasUpdate ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => openModal('updateAvailable')}
            >
              {t('whatsNew.update')}
            </button>
          ) : null}
        </>
      }
    >
      <div className={styles.hero}>
        <span className={styles.icon}>
          <Newspaper size={18} />
        </span>
        <div>
          <strong>
            {hasUpdate ? t('whatsNew.pendingTitle', { version }) : t('whatsNew.subtitle')}
          </strong>
          <p>
            {hasUpdate
              ? t('whatsNew.pendingBody', { version: updateInfo!.version })
              : t('whatsNew.body')}
          </p>
        </div>
      </div>
      {updateInfo?.notes ? (
        <div className={styles.notes}>{updateInfo.notes}</div>
      ) : (
        <div className={styles.releases}>
          {FORK_RELEASES.map((release) => (
            <ReleaseNotes key={release.version} release={release} dateLocale={dateLocale}>
              {/* The upstream name goes in as a param: the brand swap only rewrites templates. */}
              <p className={styles.upstreamBase}>
                {t('whatsNew.forkBase', {
                  upstream: UPSTREAM_NAME,
                  version: release.upstream.version,
                  commit: release.upstream.commit,
                })}
              </p>
            </ReleaseNotes>
          ))}
          <h2 className={styles.sourceHeading}>
            {t('whatsNew.upstreamHeading', { upstream: UPSTREAM_NAME })}
          </h2>
          {CHANGELOG_RELEASES.map((release) => (
            <ReleaseNotes key={release.version} release={release} dateLocale={dateLocale} />
          ))}
        </div>
      )}
    </Modal>
  )
}

function ReleaseNotes({
  release,
  dateLocale,
  children,
}: {
  release: ChangelogRelease
  dateLocale: string
  children?: ReactNode
}) {
  const t = useT()
  return (
    <section className={styles.release}>
      <h3 className={styles.releaseHeading}>
        {t('whatsNew.releaseHeading', {
          version: release.version,
          date: formatReleaseDate(release.date, dateLocale),
        })}
      </h3>
      {children}
      <ul className={styles.list}>
        {release.noteKeys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
    </section>
  )
}
