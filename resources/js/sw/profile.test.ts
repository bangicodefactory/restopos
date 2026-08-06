import { describe, expect, it } from 'vitest';

import { appOfEntry, filterManifest, resolveProfile } from './profile';

/**
 * BAN-504 — the precache contract, which is two halves that have to agree.
 *
 * `appOfEntry` decides what a build chunk is *named*; `filterManifest` decides what gets precached.
 * When they disagree the failure is silent and total: the shell loads offline, a chunk it needs is
 * not there, and the till renders a blank page. Nothing throws, nothing logs, and it shows up on the
 * morning the venue's broadband is down.
 */

const BACKSLASH = String.fromCharCode(92);

/** A Windows `facadeModuleId`, which is what Rollup passes on a Windows build host. */
function windowsPath(...segments: string[]): string {
    return ['C:', 'srv', 'app', ...segments].join(BACKSLASH);
}

describe('appOfEntry', () => {
    it('names the app from a posix path', () => {
        expect(appOfEntry('/srv/app/resources/js/register/main.tsx')).toBe('register');
    });

    it('names the app from a Windows path', () => {
        // The bug. A pattern matching only `/` returned null here, so every entry was emitted as
        // the bare `main-[hash].js`, no `entryHints` prefix matched it, and the one chunk that boots
        // the app was the one chunk missing from the offline cache.
        expect(appOfEntry(windowsPath('resources', 'js', 'register', 'main.tsx'))).toBe('register');
    });

    it('names each app distinctly', () => {
        expect(appOfEntry('/a/resources/js/kitchen/main.tsx')).toBe('kitchen');
        expect(appOfEntry('/a/resources/js/selforder/main.tsx')).toBe('selforder');
        expect(appOfEntry('/a/resources/js/backoffice/app.tsx')).toBe('backoffice');
    });

    it('returns null for something outside the app tree', () => {
        // Shared chunks and CSS have no owning app, and must fall back to the unprefixed name.
        expect(appOfEntry('/srv/app/resources/css/app.css')).toBeNull();
        expect(appOfEntry(null)).toBeNull();
        expect(appOfEntry(undefined)).toBeNull();
    });
});

describe('filterManifest', () => {
    const manifest = [
        { url: '/build/assets/register-main-abc.js', revision: null },
        { url: '/build/assets/register-i18n-xyz.js', revision: null },
        { url: '/build/assets/kitchen-main-def.js', revision: null },
        { url: '/build/assets/backoffice-Index-stu.js', revision: null },
        { url: '/build/assets/shared-ghi.js', revision: null },
        { url: '/build/assets/domain-jkl.js', revision: null },
        { url: '/build/assets/react-mno.js', revision: null },
        { url: '/build/assets/app-pqr.css', revision: null },
    ];

    it('precaches the register entry chunk', () => {
        // The assertion that would have caught this: the entry the shell actually loads has to be
        // in the list, or the offline shell is a blank page.
        const urls = filterManifest(manifest, resolveProfile('http://localhost/pos/1'));

        expect(urls).toContain('/build/assets/register-main-abc.js');
    });

    it('precaches the shared chunks and the stylesheet with it', () => {
        const urls = filterManifest(manifest, resolveProfile('http://localhost/pos/1'));

        expect(urls).toEqual(
            expect.arrayContaining([
                '/build/assets/shared-ghi.js',
                '/build/assets/domain-jkl.js',
                '/build/assets/react-mno.js',
                '/build/assets/app-pqr.css',
            ]),
        );
    });

    it('precaches a lazily-split chunk of its own app', () => {
        // The chunk that broke it: an `i18n` split the old include-list did not know to name.
        expect(filterManifest(manifest, resolveProfile('http://localhost/pos/1'))).toContain(
            '/build/assets/register-i18n-xyz.js',
        );
    });

    it('does not precache another app code', () => {
        // Three PWAs and a back office share an origin; a till has no use for any of the others,
        // and a phone should not download fifty back-office page chunks to show a menu.
        const urls = filterManifest(manifest, resolveProfile('http://localhost/pos/1'));

        expect(urls).not.toContain('/build/assets/kitchen-main-def.js');
        expect(urls).not.toContain('/build/assets/backoffice-Index-stu.js');
    });

    it('includes an unrecognised chunk rather than dropping it', () => {
        // The whole point of excluding rather than including: a chunk nobody taught this filter
        // about costs disk, where the old behaviour cost the till its ability to start.
        const withNewChunk = [...manifest, { url: '/build/assets/brand-new-chunk-zzz.js', revision: null }];

        expect(filterManifest(withNewChunk, resolveProfile('http://localhost/pos/1'))).toContain(
            '/build/assets/brand-new-chunk-zzz.js',
        );
    });

    it('precaches nothing for a scope it does not recognise', () => {
        expect(filterManifest(manifest, resolveProfile('http://localhost/somewhere-else'))).toEqual([]);
    });
});
