// Fork identity. Onetho is a fork of Alethe (Kauã Miguel, AGPL-3.0-or-later); the
// Alethe trademark is not licensed by the AGPL (see TRADEMARK.md), so everything the
// user sees goes through here. Internal identifiers (`alethe:*`, `ALETHE_*`,
// `window.alethe`, `.alethe/`) stay as they are to keep upstream merges cheap.

export const BRAND_NAME = 'Onetho'
export const BRAND_COMMAND = 'onetho'
export const BRAND_IDENTIFIER = 'com.netomoura.onetho'
export const BRAND_REPOSITORY_URL = 'https://github.com/NetoMouraJs/alethe-agents'

export const UPSTREAM_NAME = 'Alethe'
export const UPSTREAM_AUTHOR = 'Kauã Miguel'
export const UPSTREAM_REPOSITORY_URL = 'https://github.com/Kc1t/alethe-agents'

/** Swaps the upstream name for the fork's in a text taken from the translations. */
export function applyBrand(message: string): string {
  return message.replace(/Alethe/g, BRAND_NAME).replace(/\balethe\b/g, BRAND_COMMAND)
}
