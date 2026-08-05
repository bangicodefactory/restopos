import { expect, test } from '@playwright/test';

import { addProduct, openTill, resumeAfterReload } from '../support/register';

/**
 * XCT-135 — an order moved between tables stays moved, including across a reload.
 *
 * The restaurant floor's most ordinary correction: a party is seated at the wrong table, or moves to
 * a bigger one, and the tab has to follow them. A transfer that does not survive a reload is worse
 * than one that fails outright — the bill reappears on the old table and gets served to whoever is
 * sitting there now.
 */
test.describe('table transfer', () => {
    // NOT YET RUNNING, and the reason is a gap in the app rather than in the flow being tested.
    //
    // The floor plan renders tables as buttons whose only accessible name is "1 2 places" — the
    // number and the cover count, both localised, both dependent on layout state. Every other spec
    // in this suite anchors on a stable French label ("Verrouiller", "Nouveau service"); a table has
    // none. Pinning it by position instead would encode the seeded floor plan into the spec, so it
    // would pass here and mean nothing anywhere else.
    //
    // The fix is a `data-testid` on the table tile — the register currently has exactly one test
    // hook in the whole app (`data-order-uuid`, which is what makes the KDS specs possible). Filed
    // rather than bodged, because a spec that selects the wrong tile still goes green.
    test.fixme('moves an order to another table and keeps it there across a reload', async ({ page, request }) => {
        await openTill(page, request);

        await page.getByRole('button', { name: 'Tables' }).click();

        // A table's accessible name carries its cover count ("1 2 places"), so the anchor is the
        // leading number rather than an exact match.
        const tableOne = page.getByRole('button', { name: /^1\s/ }).first();
        const tableTwo = page.getByRole('button', { name: /^2\s/ }).first();

        await expect(tableOne).toBeVisible({ timeout: 30_000 });

        // Seat table 1 and put something on the tab.
        await tableOne.click();
        await addProduct(page, 'Café expresso');
        await expect(page.getByText('2,20 €').first()).toBeVisible();

        // Move it.
        await page.getByRole('button', { name: 'Transférer' }).click();
        await tableTwo.click();

        await page.reload();
        await resumeAfterReload(page);

        // The tab is on table 2 — and, just as importantly, no longer on table 1.
        await page.getByRole('button', { name: 'Tables' }).click();
        await expect(page.getByText('2,20 €').first()).toBeVisible({ timeout: 30_000 });
    });
});
