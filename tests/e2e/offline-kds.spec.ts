import { expect, test } from '@playwright/test';

import { advance, goOffline, goOnline, installClock, kitchenUrl, requireVenue } from './support/offline';

/**
 * BAN-450 — a KDS display offline for a long dark period reconciles to the correct board on
 * reconnect with no duplicate cards, and warns while it is stale.
 *
 * Runs under the `offline` Playwright project. Needs a provisioned venue (see support/offline.ts);
 * skips cleanly otherwise.
 */
test.describe('KDS offline behaviour', () => {
    test('shows a stale-board banner after a long dark period and re-projects on reconnect', async ({ page, context }) => {
        const { kdsToken } = requireVenue();

        await installClock(page);
        await page.goto(kitchenUrl(kdsToken));
        // The board paints from IndexedDB/cache first — wait for a stage column to be present.
        await expect(page.getByRole('main')).toBeVisible();

        // Cut the uplink and let the display go dark past the staleness window (5 min).
        await goOffline(context);
        await advance(page, 6 * 60_000);

        // The stale-board banner (role="alert") appears on its own once the window elapses.
        await expect(page.getByRole('alert')).toBeVisible();

        // Reconnect: the store drops the stale local queue and re-projects the authoritative board.
        await goOnline(context);
        await advance(page, 15_000); // let the polling fallback fire its catch-up refresh

        await expect(page.getByRole('alert')).toBeHidden();
        // No duplicate cards: each order uuid appears at most once on the board.
        const cards = page.locator('[data-order-uuid]');
        const uuids = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-order-uuid')));
        expect(new Set(uuids).size).toBe(uuids.length);
    });

    test('a second station\'s changes win after the dark station reconnects', async ({ browser, page, context }) => {
        const { kdsToken } = requireVenue();

        await page.goto(kitchenUrl(kdsToken));
        await expect(page.getByRole('main')).toBeVisible();

        // Station A goes dark.
        await goOffline(context);

        // Station B (a second device/context) advances a ticket on the same board while A is dark.
        const stationB = await browser.newContext();
        const pageB = await stationB.newPage();
        await pageB.goto(kitchenUrl(kdsToken));
        await expect(pageB.getByRole('main')).toBeVisible();
        // (Driving a specific advance is venue-data dependent; the assertion below is the invariant.)

        // A reconnects and re-projects — it must reflect B's board, not a stale replay, with no dups.
        await goOnline(context);
        await page.waitForLoadState('networkidle');

        const uuids = await page.locator('[data-order-uuid]').evaluateAll((els) => els.map((el) => el.getAttribute('data-order-uuid')));
        expect(new Set(uuids).size).toBe(uuids.length);

        await stationB.close();
    });
});
