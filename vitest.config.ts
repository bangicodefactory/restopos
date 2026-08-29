import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit tests only. Playwright owns the browser-level story (see playwright.config.ts).
 *
 * `include` is deliberately narrow: the repo vendors a large PHP tool mirror under tools/ that
 * contains unrelated *.test.ts files.
 */
export default defineConfig({
    resolve: {
        alias: {
            '@domain': r('./packages/domain/src'),
            '@shared': r('./resources/js/shared'),
            '@register': r('./resources/js/register'),
            '@kitchen': r('./resources/js/kitchen'),
            '@selforder': r('./resources/js/selforder'),
            '@backoffice': r('./resources/js/backoffice'),
        },
    },

    test: {
        globals: true,
        environment: 'node',
        include: [
            'packages/domain/test/**/*.test.ts',
            // The service worker was outside the include list, which is why a precache bug that
            // blanked the offline till went unnoticed (BAN-504).
            'resources/js/sw/**/*.test.ts',
            'resources/js/shared/**/*.test.ts',
            'resources/js/shared/**/*.test.tsx',
            'resources/js/register/**/*.test.ts',
            'resources/js/register/**/*.test.tsx',
            'resources/js/kitchen/**/*.test.ts',
            // `.tsx` alongside `.ts`, as every other app folder already has it. The kitchen entry
            // listed only `.ts`, so a component test for the board would have been collected by
            // nothing — the same "passes review by never running" trap as the service worker and
            // the scripts/ entry above.
            'resources/js/kitchen/**/*.test.tsx',
            'resources/js/selforder/**/*.test.ts',
            'resources/js/backoffice/**/*.test.ts',
            'resources/js/backoffice/**/*.test.tsx',
            // Repo tooling that gates a merge (BAN-517). Same lesson as the service worker above:
            // a test outside this list does not fail, it simply never runs, and the thing it was
            // written to protect is protected by nothing.
            'scripts/**/*.test.mjs',
        ],
        exclude: ['**/node_modules/**', 'vendor/**', 'tools/**', 'public/**', 'storage/**'],
        setupFiles: ['packages/domain/test/setup.ts', 'resources/js/test/setup-dom.ts'],
        // Node by default — the domain layer must run without a DOM. A shared/ test that needs one
        // opts in per file with a docblock:  /** @vitest-environment jsdom */
        // (`environmentMatchGlobs` is deprecated in Vitest 3; the docblock is the supported way.)
        clearMocks: true,
        restoreMocks: true,
        reporters: process.env.CI ? ['default', 'junit'] : ['default'],
        outputFile: { junit: 'storage/logs/vitest-junit.xml' },
        coverage: {
            provider: 'v8',
            reportsDirectory: 'storage/logs/coverage-ts',
            include: ['packages/domain/src/**', 'resources/js/shared/**'],
        },
    },
});
