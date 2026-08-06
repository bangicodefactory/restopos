import { expect, test } from '@playwright/test';

import { openTill, pin, till, typePin } from '../support/register';

/**
 * XCT-135 — a cashier can sign in with the venue's uplink down.
 *
 * This is the one that decides whether a service continues through an outage. The PIN is verified
 * against a locally held HMAC verifier, signed with the non-extractable device key issued at
 * pairing, so no round trip is needed — but only if the verifiers were cached while online, which is
 * exactly the sequence this walks.
 */
test.describe('offline PIN login', () => {
    test('unlocks the till with the network cut', async ({ page, context, request }) => {
        await openTill(page, request);

        // Lock, as a cashier does when they step away — the till stays booted and asks for the code.
        await page.getByRole('button', { name: 'Verrouiller' }).click();
        await expect(page.getByRole('heading', { name: 'Caisse verrouillée' })).toBeVisible({ timeout: 30_000 });

        await context.setOffline(true);

        await typePin(page, pin());
        await page.getByTestId('numpad-confirm').click();

        // Back on the till with no server in reach: the verifier was checked on-device.
        await expect(till(page)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: /Café expresso/ }).first()).toBeVisible();

        await context.setOffline(false);
    });

    test('refuses a wrong PIN offline rather than letting anyone in', async ({ page, context, request }) => {
        await openTill(page, request);

        await page.getByRole('button', { name: 'Verrouiller' }).click();
        await expect(page.getByRole('heading', { name: 'Caisse verrouillée' })).toBeVisible({ timeout: 30_000 });

        await context.setOffline(true);

        // A PIN that is not this employee's. Offline must not degrade to "let them in and sort it
        // out later" — that is a drawer anyone can open by waiting for the Wi-Fi to drop.
        await typePin(page, wrongPin());
        await page.getByTestId('numpad-confirm').click();

        await expect(page.getByRole('heading', { name: 'Caisse verrouillée' })).toBeVisible();
        await expect(till(page)).toBeHidden();

        await context.setOffline(false);
    });
});


/** Any four digits that are not the real PIN. */
function wrongPin(): string {
    return pin() === '9999' ? '1111' : '9999';
}
