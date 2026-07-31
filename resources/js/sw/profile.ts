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
     * URL fragments this profile needs precached. Entry chunks are emitted as
     * `assets/<app>-<name>-<hash>.js` (see `entryFileNames` in vite.config.ts), so a leading-slash
     * prefix test cleanly separates `/register-main-…` from `/kitchen-main-…` while the shared
     * chunks (`/shared-`, `/domain-`, `/react-`) and the stylesheet are picked up by every scope.
     */
    entryHints: string[];
    /** Precache product imagery? The kitchen never shows them; a phone should not hoard them. */
    cacheProductImages: boolean;
    imageCacheLimit: number;
};

const PROFILES: Record<Exclude<ProfileName, 'unknown'>, SwProfile> = {
    register: {
        name: 'register',
        scopePath: '/pos/',
        shellUrl: '/pos/',
        entryHints: ['/register-', '/shared-', '/domain-', '/react-', '.css'],
        cacheProductImages: true,
        imageCacheLimit: 3000,
    },
    kitchen: {
        name: 'kitchen',
        scopePath: '/kitchen/',
        shellUrl: '/kitchen/',
        entryHints: ['/kitchen-', '/shared-', '/domain-', '/react-', '.css'],
        // A kitchen display shows names and timers, never photographs.
        cacheProductImages: false,
        imageCacheLimit: 0,
    },
    selforder: {
        name: 'selforder',
        scopePath: '/menu/',
        shellUrl: '/menu/',
        entryHints: ['/selforder-', '/shared-', '/domain-', '/react-', '.css'],
        // The menu is the product photos; a customer's phone caches a modest number.
        cacheProductImages: true,
        imageCacheLimit: 400,
    },
};

const UNKNOWN: SwProfile = {
    name: 'unknown',
    scopePath: '/',
    shellUrl: '/',
    entryHints: [],
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
 * Filter the injected precache manifest down to what this scope needs.
 *
 * Shared chunks (`shared`, `domain`, `react`, the stylesheet) resolve to identical URLs across the
 * three profiles, so the HTTP cache is shared even though the precache manifests are not. The
 * duplication costs disk on staff devices, which have it.
 */
export function filterManifest(
    manifest: ReadonlyArray<{ url: string; revision: string | null }>,
    profile: SwProfile,
): string[] {
    if (profile.name === 'unknown') return [];
    return manifest
        .filter((entry) => profile.entryHints.some((hint) => entry.url.includes(hint)))
        .map((entry) => entry.url);
}
