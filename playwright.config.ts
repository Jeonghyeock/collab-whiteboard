import { defineConfig } from '@playwright/test';

const PORT = 3199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run build && node server/main.ts',
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT), DATA_DIR: 'test-results/e2e-data' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
