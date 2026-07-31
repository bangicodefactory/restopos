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
            'resources/js/shared/**/*.test.ts',
            'resources/js/shared/**/*.test.tsx',
            'resources/js/register/**/*.test.ts',
            'resources/js/register/**/*.test.tsx',
            'resources/js/kitchen/**/*.test.ts',
            'resources/js/selforder/**/*.test.ts',
            'resources/js/backoffice/**/*.test.ts',
            'resources/js/backoffice/**/*.test.tsx',
        ],
        exclude: ['**/node_modules/**', 'vendor/**', 'tools/**', 'public/**', 'storage/**'],
        setupFiles: ['packages/domain/test/setup.ts'],
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
