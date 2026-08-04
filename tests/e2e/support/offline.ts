import { type BrowserContext, type Page, test } from '@playwright/test';

/**
 * Offline / multi-device simulation harness (BAN-450, XCT-135).
 *
 * The unattended shells (KDS, self-order) are propless — the URL token is only a hint; the app
 * authenticates against `/api/*`. So a spec needs seeded venue tokens. The harness reads them from
 * the environment, which the seed step (`php artisan db:seed`, then query
 * `prep_displays.access_token` / `pos_configs.access_token`) exports before `npm run e2e`:
 *
 *   PLAYWRIGHT_KDS_TOKEN         — a prep_displays.access_token (drives /kitchen/{token})
 *   PLAYWRIGHT_SELFORDER_TOKEN   — a pos_configs.access_token with self_ordering enabled
 *   PLAYWRIGHT_TABLE_TOKEN       — a restaurant_tables.identifier (the ?tt= capability token)
 *
 * When a token is absent the spec `skip`s rather than fails, so the suite is green on a machine that
 * has not provisioned the venue. `context.setOffline` cuts one *device's* uplink, which is how both
 * "offline" and "one of two devices" are simulated — a second BrowserContext is a second device.
 */

export type VenueTokens = {
    kdsToken: string;
    selfOrderToken: string;
    tableToken: string | null;
};

/** The seeded tokens, or `null` when the run was not provisioned (the caller should skip). */
export function venueTokens(): VenueTokens | null {
    const kdsToken = process.env.PLAYWRIGHT_KDS_TOKEN;
    const selfOrderToken = process.env.PLAYWRIGHT_SELFORDER_TOKEN;
    if (!kdsToken || !selfOrderToken) {
        return null;
    }
    return { kdsToken, selfOrderToken, tableToken: process.env.PLAYWRIGHT_TABLE_TOKEN ?? null };
}

/** Skip the current spec unless the venue tokens were provisioned. Returns them when present. */
export function requireVenue(): VenueTokens {
    const tokens = venueTokens();
    test.skip(tokens === null, 'Set PLAYWRIGHT_KDS_TOKEN / PLAYWRIGHT_SELFORDER_TOKEN (seed the venue) to run the offline e2e.');
    return tokens as VenueTokens;
}

export function kitchenUrl(token: string): string {
    return `/kitchen/${token}`;
}

export function selfOrderUrl(token: string, tableToken: string | null): string {
    return tableToken ? `/menu/${token}?tt=${tableToken}` : `/menu/${token}`;
}

/** Cut this device's uplink (a dead venue Wi-Fi, not a closed lid). */
export async function goOffline(context: BrowserContext): Promise<void> {
    await context.setOffline(true);
}

/** Restore this device's uplink. */
export async function goOnline(context: BrowserContext): Promise<void> {
    await context.setOffline(false);
}

/**
 * Fast-forward the wall clock so "dark for an hour" doesn't take an hour — the KDS staleness window
 * and self-order timers read `Date.now()`. Install before navigation.
 */
export async function installClock(page: Page): Promise<void> {
    await page.clock.install();
}

export async function advance(page: Page, ms: number): Promise<void> {
    await page.clock.fastForward(ms);
}
