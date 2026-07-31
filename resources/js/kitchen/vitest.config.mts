import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit tests for the kitchen display's pure logic.
 *
 * The root `vitest.config.ts` narrows `include` to `packages/domain/test/**` and
 * `resources/js/shared/**` — app folders are not in it, and that file is outside this agent's
 * scope. So the app ships its own config rather than silently having untested tests:
 *
 *     npx vitest run --config resources/js/kitchen/vitest.config.mts
 *
 * Folding these into `npm run test` is a one-line addition to the root config's `include` array.
 * The file is `.mts` so it is matched by neither `tsconfig.json` (`resources/js/ ** /*.ts`) nor the
 * eslint globs — a test runner config is not application code and should not be typechecked as if
 * it were.
 */
export default defineConfig({
    resolve: {
        alias: {
            '@domain': r('../../../packages/domain/src'),
            '@shared': r('../shared'),
            '@kitchen': r('.'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['resources/js/kitchen/**/*.test.ts', 'resources/js/kitchen/**/*.test.tsx'],
        root: r('../../..'),
        clearMocks: true,
        restoreMocks: true,
    },
});
