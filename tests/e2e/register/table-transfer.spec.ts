import { expect, test } from '@playwright/test';

import {
    addProduct,
    openTill,
    orderLines,
    orderTotalValue,
    resumeAfterReload,
    tableTile,
} from '../support/register';

/**
 * XCT-135 — an order moved between tables stays moved, including across a reload.
 *
 * The restaurant floor's most ordinary correction: a party is seated at the wrong table, or moves to
 * a bigger one, and the tab has to follow them. A transfer that does not survive a reload is worse
 * than one that fails outright — the bill reappears on the old table and gets served to whoever is
 * sitting there now.
 */
test.describe('table transfer', () => {
    // STILL NOT RUNNING — but for a different reason than before, and that difference is the point
    // of BAN-505. It is no longer blocked on selectors: the spec now finds tables by number, seats
    // one, adds a line and reaches the "choose the destination table" prompt. It is blocked on
    // BAN-506, a real defect this exercise uncovered: a till paired into a session that already
    // holds its tracking number has every order rejected with `ingest_failed`, so the order has no
    // server id and the transfer cannot be performed.
    //
    // Left as the spec it should be, rather than weakened to assert the broken behaviour.
    test.fixme('moves an order to another table and keeps it there across a reload', async ({ page, request }) => {
        await openTill(page, request);

        await page.getByRole('button', { name: 'Tables' }).click();

        // Addressed by number, not by position and not by the localised "1 2 places" label — which
        // is what kept this spec unrunnable until the tiles carried a test id (BAN-505).
        const one = tableTile(page, 1);
        const two = tableTile(page, 2);

        await expect(one).toBeVisible({ timeout: 30_000 });

        // Seat table 1 and put something on the tab.
        await one.click();
        await addProduct(page, 'Café expresso');
        await expect(orderLines(page)).toHaveCount(1);

        const total = await orderTotalValue(page);
        expect(total).not.toBe('0');

        // Move it.
        await page.getByRole('button', { name: 'Transférer' }).click();
        await two.click();

        await page.reload();
        await resumeAfterReload(page);

        await page.getByRole('button', { name: 'Tables' }).click();

        // The tab is on table 2 — and, just as importantly, no longer on table 1. Both assertions
        // matter: a transfer that copies rather than moves would satisfy only the first.
        await expect(tableTile(page, 2)).toHaveAttribute('data-occupied', 'true', { timeout: 30_000 });
        await expect(tableTile(page, 1)).toHaveAttribute('data-occupied', 'false');

        // …and the money went with it.
        await tableTile(page, 2).click();
        expect(await orderTotalValue(page)).toBe(total);
    });
});
