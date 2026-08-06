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
    await page.getByTestId('pairing-code').fill(code as string);
    await page.getByRole('button', { name: 'Appairer' }).click();

    await signIn(page);
}

/** Employee sign-in: pick the name, tap the PIN, open the till. */
export async function signIn(page: Page): Promise<void> {
    // The employee is chosen by name on purpose — that is the text a human reads off the screen,
    // and asserting it is asserting something real. Everything structural below goes through a test
    // id (BAN-505).
    const employee = page.getByRole('button', { name: employeeName() });
    await expect(employee).toBeVisible({ timeout: 30_000 });
    await employee.click();

    await typePin(page, pin());
    await page.getByTestId('numpad-confirm').click();

    await expect(till(page)).toBeVisible({ timeout: 30_000 });
}

/** Tap a code into whichever numpad is on screen. */
export async function typePin(page: Page, code: string): Promise<void> {
    for (const digit of code.split('')) {
        await page.getByTestId('numpad-key').and(page.locator(`[data-key="${digit}"]`)).click();
    }
}

/** The product grid's "new order" button — the marker that the till is open for business. */
export function till(page: Page) {
    return page.getByRole('button', { name: '+ Nouvelle commande' });
}

/** A table on the floor plan, addressed by its number rather than its localised label. */
export function tableTile(page: Page, tableNumber: number | string) {
    return page.getByTestId('table-tile').and(page.locator(`[data-table-number="${tableNumber}"]`));
}

/** The fire button for one course. */
export function courseFire(page: Page, index: number) {
    return page.getByTestId('course-fire').and(page.locator(`[data-course-index="${index}"]`));
}

/** The order's running total, as the raw value rather than a formatted string. */
export async function orderTotalValue(page: Page): Promise<string> {
    return (await orderTotal(page).getAttribute('data-order-total')) ?? '';
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

/**
 * Add a product to the current order by its visible name.
 *
 * Still by name: which product a spec adds is a domain choice a reader needs to see, and a product's
 * name is stable text rather than a state-dependent label.
 *
 * Matched against the name element rather than the tile's text, which also carries the price and a
 * cart badge. Anchoring a regex at the start of the tile's whole text worked only because the name
 * happens to be rendered first — a positional assumption inside the very element the hook exists to
 * make position-free.
 */
export async function addProduct(page: Page, name: string): Promise<void> {
    await page
        .getByTestId('product-tile')
        .filter({ has: page.getByTestId('product-name').getByText(name, { exact: true }) })
        .first()
        .click();
}

/** The payment button, which doubles as the order's running total. */
export function orderTotal(page: Page) {
    return page.getByTestId('order-total');
}

/** The lines currently on the order. */
export function orderLines(page: Page) {
    return page.getByTestId('order-line');
}

export async function xsrf(request: APIRequestContext): Promise<string> {
    const cookies = (await request.storageState()).cookies;

    return decodeURIComponent(cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
