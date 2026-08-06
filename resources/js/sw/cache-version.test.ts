import { describe, expect, it } from 'vitest';

import { cacheNames, manifestVersion, resolveProfile } from './profile';

/**
 * BAN-504 — cache names have to change when a deploy changes the assets.
 *
 * `VERSION` was the constant `'v1'`, so every cache name was stable forever and the `activate`
 * cleanup — which deletes caches no longer named in `names` — could never delete anything. Asset
 * filenames are content-hashed, so each deploy added a fresh set of chunks and kept every previous
 * set, on a device whose storage policy is otherwise careful enough to distinguish an evictable
 * product photo from a receipt logo it must not lose.
 *
 * The worker derives its version from the injected manifest. `manifestVersion` lives in `profile.ts`
 * rather than in `sw.ts` for exactly this reason: `sw.ts` reaches for `self.registration` at import
 * time and cannot load under vitest, so a digest defined there could only be tested by restating it
 * — and a restated implementation is one that silently stops matching.
 */

const buildA = [
    { url: '/build/assets/register-main-aaa.js', revision: null },
    { url: '/build/assets/shared-bbb.js', revision: null },
];

const buildB = [
    { url: '/build/assets/register-main-ccc.js', revision: null },
    { url: '/build/assets/shared-bbb.js', revision: null },
];

describe('manifestVersion', () => {
    it('is stable for the same manifest', () => {
        // A worker restarting on an unchanged deploy must reuse its caches, not orphan them.
        expect(manifestVersion(buildA)).toBe(manifestVersion(buildA));
    });

    it('changes when any asset hash changes', () => {
        // The property the whole fix rests on: new build, new cache names, old ones swept.
        expect(manifestVersion(buildA)).not.toBe(manifestVersion(buildB));
    });

    it('changes when an asset is added', () => {
        expect(manifestVersion(buildA)).not.toBe(
            manifestVersion([...buildA, { url: '/build/assets/new-ddd.js', revision: null }]),
        );
    });

    it('is not the literal that broke it', () => {
        expect(manifestVersion(buildA)).not.toBe('v1');
    });

    it('survives an empty manifest without throwing', () => {
        expect(manifestVersion([])).toMatch(/^v[0-9a-z]+$/);
    });
});

describe('cacheNames', () => {
    it('carries the version into every cache name', () => {
        // This is what makes `activate`'s cleanup able to fire: the old names are no longer in
        // `names`, so it deletes them.
        const version = manifestVersion(buildA);
        const names = cacheNames(resolveProfile('http://localhost/pos/1'), version);

        for (const key of ['precache', 'shell', 'assets', 'fonts', 'images'] as const) {
            expect(names[key]).toContain(version);
        }
    });

    it('keeps the three PWAs in separate caches', () => {
        // Updating the register must not evict the kiosk's shell.
        const version = manifestVersion(buildA);
        const register = cacheNames(resolveProfile('http://localhost/pos/1'), version);
        const kitchen = cacheNames(resolveProfile('http://localhost/kitchen/abc'), version);

        expect(register.shell).not.toBe(kitchen.shell);
    });

    it('shares the prefix that the activate sweep filters on', () => {
        const names = cacheNames(resolveProfile('http://localhost/pos/1'), 'vzz');

        // `activate` deletes keys starting with this prefix that are not current — so every cache
        // name must actually start with it, or a stale cache is invisible to the sweep.
        for (const key of ['precache', 'shell', 'assets', 'fonts', 'images'] as const) {
            expect(names[key].startsWith(names.prefix)).toBe(true);
        }
    });
});
