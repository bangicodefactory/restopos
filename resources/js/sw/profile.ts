/**
 * Scope → app profile.
 *
 * One worker script is registered three times, once per scope (see `vite.config.ts`). Each
 * registration reads its own `self.registration.scope` at startup and behaves as that app: its own
 * navigation fallback, its own precache subset, and — because every cache name is derived from the
 * scope — its own cache storage. Updating the register cannot evict the kiosk's shell.
 */

export type ProfileName = 'register' | 'kitchen' | 'selforder' | 'unknown';

export type SwProfile = {
    name: ProfileName;
    /** URL prefix this registration controls. */
    scopePath: string;
    /** Document served for every navigation inside the scope. */
    shellUrl: string;
    /**
     * This profile's own build-entry prefix, e.g. `register-`.
     *
     * Entry chunks are emitted as `assets/<app>-<name>-<hash>.js` (see `entryFileNames` in
     * vite.config.ts), which is what lets `filterManifest` tell `register-main-…` from
     * `kitchen-main-…` and precache everything else.
     */
    appPrefix: string;

    /** Precache product imagery? The kitchen never shows them; a phone should not hoard them. */
    cacheProductImages: boolean;
    imageCacheLimit: number;
};

const PROFILES: Record<Exclude<ProfileName, 'unknown'>, SwProfile> = {
    register: {
        name: 'register',
        appPrefix: 'register-',
        scopePath: '/pos/',
        shellUrl: '/pos/',
        cacheProductImages: true,
        imageCacheLimit: 3000,
    },
    kitchen: {
        name: 'kitchen',
        appPrefix: 'kitchen-',
        scopePath: '/kitchen/',
        shellUrl: '/kitchen/',
        // A kitchen display shows names and timers, never photographs.
        cacheProductImages: false,
        imageCacheLimit: 0,
    },
    selforder: {
        name: 'selforder',
        appPrefix: 'selforder-',
        scopePath: '/menu/',
        shellUrl: '/menu/',
        // The menu is the product photos; a customer's phone caches a modest number.
        cacheProductImages: true,
        imageCacheLimit: 400,
    },
};

const UNKNOWN: SwProfile = {
    name: 'unknown',
    appPrefix: '',
    scopePath: '/',
    shellUrl: '/',
    cacheProductImages: false,
    imageCacheLimit: 0,
};

export function resolveProfile(scope: string): SwProfile {
    const path = new URL(scope).pathname;
    for (const profile of Object.values(PROFILES)) {
        if (path.startsWith(profile.scopePath)) return profile;
    }
    return UNKNOWN;
}

/** Cache names are scope-derived, which is what keeps the three PWAs' storage independent. */
export function cacheNames(profile: SwProfile, version: string): {
    precache: string;
    shell: string;
    assets: string;
    fonts: string;
    images: string;
    prefix: string;
} {
    const prefix = `restopos-${profile.name}`;
    return {
        prefix,
        precache: `${prefix}-precache-${version}`,
        shell: `${prefix}-shell-${version}`,
        assets: `${prefix}-assets-${version}`,
        fonts: `${prefix}-fonts-${version}`,
        images: `${prefix}-images-${version}`,
    };
}

/**
 * The app a build entry belongs to, from its source path.
 *
 * Lives here rather than inline in `vite.config.ts` because it is exactly half of the precache
 * contract — the other half being `filterManifest` below — and because it was wrong in a way only a
 * test would catch. Rollup's `facadeModuleId` is an OS path, so on Windows it arrives with
 * backslashes; a pattern matching only `resources/js/` silently returned undefined, every entry was
 * emitted as the bare `main-[hash].js`, no hint matched it, and the one chunk that boots the app was
 * the one chunk left out of the offline cache. The shell then loaded offline and rendered nothing
 * (BAN-504).
 */
export function appOfEntry(facadeModuleId: string | null | undefined): string | null {
    if (!facadeModuleId) return null;

    // `[\\/]` — either separator. Rollup hands back an OS path, so this is a backslash on Windows.
    return /resources[\\/]js[\\/]([^\\/]+)[\\/]/.exec(facadeModuleId)?.[1] ?? null;
}

/**
 * Filter the injected precache manifest down to what this scope needs.
 *
 * **Exclude, not include.** This used to keep only entries matching a hand-written list of chunk-name
 * fragments, which meant every new shared chunk was silently left out of the offline cache — and a
 * missing chunk is not a degraded till, it is a blank screen, discovered on the morning the venue's
 * line is down. A lazily-split `i18n-` chunk did exactly that (BAN-504).
 *
 * Inverting it flips the failure mode from "silently missing" to "slightly larger cache", which is
 * the right way round for a device whose whole purpose is to keep working without a network.
 *
 * Shared chunks resolve to identical URLs across the three profiles, so the HTTP cache is shared even
 * though the precache manifests are not. The duplication costs disk on staff devices, which have it.
 */
export function filterManifest(
    manifest: ReadonlyArray<{ url: string; revision: string | null }>,
    profile: SwProfile,
): string[] {
    if (profile.name === 'unknown') return [];

    const foreign = Object.values(PROFILES)
        .map((other) => other.appPrefix)
        .concat('backoffice-')
        .filter((prefix) => prefix !== profile.appPrefix);

    return manifest
        .filter((entry) => {
            const file = entry.url.split('/').pop() ?? '';

            // Another app's entry chunk is the only thing a till has no use for.
            return !foreign.some((prefix) => file.startsWith(prefix));
        })
        .map((entry) => entry.url);
}
