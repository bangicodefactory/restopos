import { expect, test } from '@playwright/test';

import { addProduct, courseFire, openTill, orderLines, seatFreeTable, till } from '../support/register';

/**
 * XCT-135 — two courses, fired one at a time.
 *
 * The restaurant flow the kitchen depends on: starters go now, mains go when the table is ready, and
 * firing the second course must send *only* the second course. The failure this guards against is
 * the kitchen receiving the whole ticket twice, which is indistinguishable from a double order at
 * the pass and gets thrown away as food.
 */
test.describe('two-course fire', () => {
    test('fires each course separately', async ({ page, request }) => {
        await openTill(page, request);

        // Courses exist on a table order; a direct sale has none.
        await seatFreeTable(page);

        // Starter.
        await addProduct(page, 'Soupe à l’oignon gratinée');

        // Second course: everything added after this belongs to it.
        // A product with variant attributes opens a configurator dialog that covers the panel, so
        // the second course uses a plain one — this spec is about courses, not about attributes.
        await page.getByRole('button', { name: 'Nouveau service' }).click();
        await addProduct(page, 'Café expresso');

        // A second course makes each one separately fireable — that is the feature: the starter
        // goes now, the main goes when the table is ready. With a single course there is only the
        // send-all button, which is why these appear after `Nouveau service` and not before.
        const fireFirst = courseFire(page, 1);
        const fireSecond = courseFire(page, 2);

        await expect(fireFirst).toBeVisible({ timeout: 30_000 });
        await expect(fireSecond).toBeVisible();

        await fireFirst.click();

        // The second course is still there to fire: sending one course must not send the ticket.
        await expect(fireSecond).toBeVisible({ timeout: 30_000 });
    });

    test('keeps the courses distinct on the order', async ({ page, request }) => {
        await openTill(page, request);

        await seatFreeTable(page);
        await addProduct(page, 'Soupe à l’oignon gratinée');

        await page.getByRole('button', { name: 'Nouveau service' }).click();
        await addProduct(page, 'Café expresso');

        // Both items are on the one order — a new course must not start a new ticket. The names are
        // asserted as *text* on purpose: that is what a cashier reads. The count comes from the test
        // id, because "how many lines" is structure.
        await expect(orderLines(page)).toHaveCount(2);
        await expect(page.getByText('Soupe à l’oignon gratinée').first()).toBeVisible();
        await expect(page.getByText('Café expresso').first()).toBeVisible();
    });
});
