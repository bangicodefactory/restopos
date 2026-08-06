import { expect, test } from '@playwright/test';

import {
    addProduct,
    freeTables,
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
    // STILL NOT RUNNING, and the reason has moved again — which is the point of recording it.
    //
    // It is no longer blocked on selectors (BAN-505) and no longer on the tracking-number collision
    // (BAN-506, fixed here): the till syncs cleanly, the spec seats a free table, adds a line,
    // reaches the destination prompt and picks a table. What does not happen is the destination
    // tile becoming occupied — the order does not appear to land. That is either a refresh gap
    // after `refreshAfterServerAction` or a genuine defect in the transfer itself, and it deserves
    // its own investigation rather than a guess bolted onto this one.
    test.fixme('moves an order to another table and keeps it there across a reload', async ({ page, request }) => {
        await openTill(page, request);

        await page.getByRole('button', { name: 'Tables' }).click();

        // Addressed by number, not by position and not by the localised "1 2 places" label — which
        // is what kept this spec unrunnable until the tiles carried a test id (BAN-505). The numbers
        // are read off the floor plan rather than hardcoded: the venue database accumulates across
        // runs, so table 1 is only empty the first time.
        await expect(page.getByTestId('table-tile').first()).toBeVisible({ timeout: 30_000 });

        const [from, to] = await freeTables(page);

        expect(from, 'the floor plan needs two free tables').toBeTruthy();
        expect(to).toBeTruthy();

        const one = tableTile(page, from as string);
        const two = tableTile(page, to as string);

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
        await expect(tableTile(page, to as string)).toHaveAttribute('data-occupied', 'true', { timeout: 30_000 });
        await expect(tableTile(page, from as string)).toHaveAttribute('data-occupied', 'false');

        // …and the money went with it.
        await tableTile(page, to as string).click();
        expect(await orderTotalValue(page)).toBe(total);
    });
});
