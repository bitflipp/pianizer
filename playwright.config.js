import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:        './tests/ui',
  fullyParallel:  false,
  workers:        1,
  reporter:       'line',
  use: {
    baseURL:  'http://localhost:8765',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'chromium' },
  ],
  webServer: {
    command:              'python3 -m http.server 8765 2>/dev/null',
    port:                 8765,
    reuseExistingServer:  !process.env.CI,
  },
});
