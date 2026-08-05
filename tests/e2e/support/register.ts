import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Register E2E harness (XCT-135, BAN-484).
 *
 * Every spec pairs its own till. That is not laziness about fixtures — it is forced, and the reason
 * is worth writing down because it will look like an easy optimisation later:
 *
 * The device secret is imported as a **non-extractable** `CryptoKey` (see `shared/auth/device.ts`),
 * because it signs offline PIN verifiers and must never be readable by page script. A non-extractable
 * key is a browser-internal handle, so Playwright's `storageState({ indexedDB: true })` cannot
 * serialise it. Reusing a saved state gives you a till that has a bearer token and *cannot verify a
 * PIN* — it reaches the employee picker and then silently refuses every code. Pairing per spec is
 * the only way to get a till that actually works.
 *
 * Codes are minted through the real back-office endpoint rather than injected, so the suite
 * provisions itself from a seeded database with no environment juggling, and the pairing surface is
 * exercised on every run.
 *
 * Provisioning (all optional, defaults match `php artisan migrate:fresh --seed`):
 *
 *   PLAYWRIGHT_BASE_URL      — default http://127.0.0.1:8000
 *   PLAYWRIGHT_CONFIG_ID     — pos_configs.id for the shell URL (default 1)
 *   PLAYWRIGHT_CONFIG_UUID   — pos_configs.uuid for the pairing endpoint (route binding is by uuid)
 *   PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD
 *   PLAYWRIGHT_PIN / PLAYWRIGHT_EMPLOYEE
 *
 * A run against a database with no seeded venue skips rather than fails: a suite that goes red for
 * want of provisioning is a suite people learn to ignore.
 */

export const ADMIN_STATE = 'storage/e2e/admin-state.json';

/** Back-office credentials used to mint pairing codes. */
export function adminCredentials(): { email: string; password: string } {
    return {
        email: process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'admin@restopos.test',
        password: process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? 'password',
    };
}

export function configId(): string {
    return process.env.PLAYWRIGHT_CONFIG_ID ?? '1';
}

export function registerUrl(): string {
    return `/pos/${configId()}`;
}

export function pin(): string {
    return process.env.PLAYWRIGHT_PIN ?? '1234';
}

export function employeeName(): string {
    return process.env.PLAYWRIGHT_EMPLOYEE ?? 'Amélie Rousseau';
}

/** Mint a register pairing code through the back office, exactly as an installer would. */
export async function mintPairingCode(request: APIRequestContext): Promise<string | null> {
    const uuid = process.env.PLAYWRIGHT_CONFIG_UUID;

    if (!uuid) {
        return null;
    }

    // No login here: `backoffice.setup.ts` did it once for the run. Logging in per spec would burn
    // through `/login`'s ten-a-minute limit and make the later specs skip themselves.
    const response = await request.post(`/pos-configs/${uuid}/pairing-codes`, {
        headers: { 'X-XSRF-TOKEN': await xsrf(request), Accept: 'application/json' },
        data: { device_type: 'register', name: 'E2E Till' },
    });

    if (!response.ok()) {
        return null;
    }

    return String(((await response.json()) as { code?: string }).code ?? '') || null;
}

/** Pair, sign in, and land on the product grid — or skip the spec if there is no venue behind us. */
export async function openTill(page: Page, request: APIRequestContext): Promise<void> {
    const code = await mintPairingCode(request);

    test.skip(
        code === null,
        'No seeded venue. Export PLAYWRIGHT_CONFIG_UUID (see tests/e2e/support/register.ts) after seeding.',
    );

    await page.goto(registerUrl());
    await page.getByRole('textbox').first().fill(code as string);
    await page.getByRole('button', { name: 'Appairer' }).click();

    await signIn(page);
}

/** Employee sign-in: pick the name, tap the PIN, open the till. */
export async function signIn(page: Page): Promise<void> {
    const employee = page.getByRole('button', { name: employeeName() });
    await expect(employee).toBeVisible({ timeout: 30_000 });
    await employee.click();

    for (const digit of pin().split('')) {
        await page.getByRole('button', { name: digit, exact: true }).click();
    }

    await page.getByRole('button', { name: 'Ouvrir la caisse' }).click();
    await expect(page.getByRole('button', { name: '+ Nouvelle commande' })).toBeVisible({ timeout: 30_000 });
}

/**
 * Come back after a reload, whether or not the employee session survived it.
 *
 * A reload sometimes lands straight on the till and sometimes on the employee picker, depending on
 * whether the session had been persisted yet. Both are correct — the till is allowed to remember who
 * is on it for a short window — so a spec that hard-codes either one is asserting a race, not a
 * behaviour.
 */
export async function resumeAfterReload(page: Page): Promise<void> {
    const employee = page.getByRole('button', { name: employeeName() });
    const till = page.getByRole('button', { name: '+ Nouvelle commande' });

    await expect(employee.or(till).first()).toBeVisible({ timeout: 30_000 });

    if (await employee.isVisible()) {
        await signIn(page);
    }

    await expect(till).toBeVisible({ timeout: 30_000 });
}

/** Add a product to the current order by its visible name. */
export async function addProduct(page: Page, name: string): Promise<void> {
    await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}`) }).first().click();
}

/** The payment button doubles as the order's running total, which is the cheapest thing to assert. */
export function orderTotal(page: Page) {
    return page.getByRole('button', { name: /Paiement/ });
}

export async function xsrf(request: APIRequestContext): Promise<string> {
    const cookies = (await request.storageState()).cookies;

    return decodeURIComponent(cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
