import { devices, type PlaywrightTestConfig } from '@playwright/test';

const DEFAULT_WEB_PORT = 1235;
const webPort = Number(process.env.PARVANE_E2E_WEB_PORT || DEFAULT_WEB_PORT);

const config: PlaywrightTestConfig = {
  testDir: 'tests/playwright',
  outputDir: 'test-results',
  timeout: process.env.CI ? 60 * 5 * 1000 : 60 * 2 * 1000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  webServer: {
    command: `npm run build:production && vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
    port: webPort,
    timeout: 120 * 1000,
    reuseExistingServer: false,
  },
  use: {
    baseURL: `http://127.0.0.1:${webPort}/`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: { 'network.proxy.type': 0 },
        },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'ios',
      use: { ...devices['iPhone X'] },
    },
  ],
};
export default config;
