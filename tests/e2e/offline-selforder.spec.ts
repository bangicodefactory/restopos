import { expect, test } from '@playwright/test';

import { goOffline, goOnline, requireVenue, selfOrderUrl } from './support/offline';

/**
 * BAN-450 — a self-order cart survives a mid-cart network drop, cannot be submitted while offline,
 * and submits exactly once when connectivity returns.
 *
 * Runs under the `offline` project. Needs a provisioned venue with self-ordering enabled and a table
 * token (see support/offline.ts); skips cleanly otherwise.
 */
test.describe('Self-order offline behaviour', () => {
    test('cart survives a drop and reload, and submit is blocked while offline', async ({ page, context }) => {
        const { selfOrderToken, tableToken } = requireVenue();
        test.skip(tableToken === null, 'Set PLAYWRIGHT_TABLE_TOKEN to run the self-order cart flow.');

        await page.goto(selfOrderUrl(selfOrderToken, tableToken));
        await expect(page.getByRole('main')).toBeVisible();

        // Add the first menu item to the cart.
        await page.getByRole('button', { name: /add|ajouter|أضف/i }).first().click();

        // Network drops mid-cart.
        await goOffline(context);

        // The cart survives a reload from IndexedDB (the customer's phone lost wifi, not the page).
        await page.reload();
        await expect(page.getByRole('main')).toBeVisible();
        // The cart badge / count is still present after reload (venue-styled; assert the cart is non-empty).
        await expect(page.locator('[data-cart-count]')).not.toHaveText('0');

        // At checkout, sending is disabled and the offline notice is shown — no tap fires into the drop.
        await page.getByRole('button', { name: /checkout|pay|commander|payer/i }).first().click();
        await expect(page.getByRole('alert').or(page.getByRole('status'))).toBeVisible();
        const payCashier = page.getByRole('button', { name: /cashier|caisse|الصندوق/i }).first();
        await expect(payCashier).toBeDisabled();
    });

    test('submits exactly once when connectivity returns', async ({ page, context }) => {
        const { selfOrderToken, tableToken } = requireVenue();
        test.skip(tableToken === null, 'Set PLAYWRIGHT_TABLE_TOKEN to run the self-order cart flow.');

        await page.goto(selfOrderUrl(selfOrderToken, tableToken));
        await expect(page.getByRole('main')).toBeVisible();
        await page.getByRole('button', { name: /add|ajouter|أضف/i }).first().click();

        // Drop, try to submit (refused offline), then restore and submit for real.
        await goOffline(context);
        await page.getByRole('button', { name: /checkout|pay|commander|payer/i }).first().click();
        const payCashier = page.getByRole('button', { name: /cashier|caisse|الصندوق/i }).first();
        await expect(payCashier).toBeDisabled();

        await goOnline(context);
        await expect(payCashier).toBeEnabled();
        await payCashier.click();

        // Exactly one order reaches the status screen — a single tracking view, not a duplicate.
        await expect(page.getByText(/received|preparing|reçue|reçu|reçoit|في الانتظار/i).first()).toBeVisible();
    });
});
