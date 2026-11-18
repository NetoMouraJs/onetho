import { defineConfig } from '@playwright/test'

/**
 * Smoke opcional: valida que o Vite sobe e que um stub mínimo de Tauri permite
 * hidratar o `#root`. Não roda no CI principal (ver docs/TESTING.md).
 */
export default defineConfig({
  testDir: 'playwright',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:1422',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1422',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})