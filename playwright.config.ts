import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8000';

/**
 * E2E — the Odoo "tour" equivalents (spec 03 §9.3) plus the offline simulations (§9.4).
 *
 * Projects mirror the real hardware: a landscape till, a kitchen TV, a customer phone.
 * The offline project runs with `offline: true` contexts so the register must cold-boot from
 * IndexedDB alone.
 */
export default defineConfig({
    testDir: './tests/e2e',
    testMatch: /.*\.spec\.ts$/,
    outputDir: './storage/logs/playwright',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI
        ? [['github'], ['html', { outputFolder: 'storage/logs/playwright-report', open: 'never' }]]
        : [['list']],

    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        video: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // Register/KDS/kiosk are unattended devices: never wait for a human.
        actionTimeout: 15_000,
        permissions: ['clipboard-read', 'clipboard-write'],
    },

    projects: [
        // One back-office login for the whole run: `/login` is rate limited, and a spec that cannot
        // mint a pairing code skips itself, so per-spec logins make the suite quietly shrink.
        {
            name: 'setup',
            testMatch: /.*\.setup\.ts$/,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'register',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 },
                hasTouch: true,
                isMobile: false,
                // The admin session, so each spec can mint its own pairing code without logging in.
                storageState: './storage/e2e/admin-state.json',
            },
            testMatch: /register\/.*\.spec\.ts$/,
            dependencies: ['setup'],
        },
        {
            name: 'kitchen',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
            testMatch: /kitchen\/.*\.spec\.ts$/,
        },
        {
            name: 'selforder',
            use: { ...devices['Pixel 7'] },
            testMatch: /selforder\/.*\.spec\.ts$/,
        },
        {
            name: 'backoffice',
            use: { ...devices['Desktop Chrome'] },
            testMatch: /backoffice\/.*\.spec\.ts$/,
        },
        {
            name: 'offline',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 },
                hasTouch: true,
            },
            // `offline/foo.spec.ts` and the top-level `offline-kds.spec.ts` / `offline-selforder.spec.ts`.
            testMatch: /offline[-/].*\.spec\.ts$/,
        },
    ],

    webServer: process.env.PLAYWRIGHT_NO_SERVER
        ? undefined
        : {
              command: 'php artisan serve --host=127.0.0.1 --port=8000',
              url: BASE_URL,
              reuseExistingServer: !process.env.CI,
              timeout: 120_000,
          },
});
