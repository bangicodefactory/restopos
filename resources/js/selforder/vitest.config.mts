import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit tests for the self-order app's pure logic (cart, combos, availability).
 *
 * The root `vitest.config.ts` narrows `include` to `packages/domain/test/**` and
 * `resources/js/shared/**`, and that file is outside this agent's scope — so the app ships its own
 * config rather than silently having untested tests:
 *
 *     npx vitest run --config resources/js/selforder/vitest.config.mts
 *
 * Folding these into `npm run test` is a one-line addition to the root config's `include` array.
 * The `.mts` extension keeps a test-runner config out of the app's `tsconfig` and eslint globs.
 */
export default defineConfig({
    resolve: {
        alias: {
            '@domain': r('../../../packages/domain/src'),
            '@shared': r('../shared'),
            '@selforder': r('.'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['resources/js/selforder/**/*.test.ts', 'resources/js/selforder/**/*.test.tsx'],
        root: r('../../..'),
        clearMocks: true,
        restoreMocks: true,
    },
});
