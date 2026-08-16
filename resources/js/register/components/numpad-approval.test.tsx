/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';

import { hmacHex, importDeviceKey, sha256Hex } from '@shared/auth';
import { PosDb, dbNameFor } from '@shared/db';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import {
    installCatalog,
    makeConfig,
    makeEmployee,
    makeProduct,
    makeTax,
    makeVariant,
    resetRegisterState,
} from '../domain/__fixtures__/catalog';
import { addLine, configureOrderActions, createOrder } from '../domain/order-actions';
import { useSessionStore } from '@shared/auth';

import { useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';
import { ApprovalDialog } from './dialogs/ApprovalDialog';
import { NumpadPanel } from './NumpadPanel';

/**
 * BAN-518 / REG-045 — a right the cashier lacks is a question, not a wall.
 *
 * Price editing and an over-limit discount were a disabled button carrying a `title` that explained
 * why. On the tablet this runs on there is no hover, so the explanation was invisible and the till
 * simply appeared to ignore the tap. Meanwhile the server had grown two halves of a mechanism —
 * validating approvals (BAN-430) and binding one to the line it names (BAN-515) — that **no UI
 * could ever exercise**, because nothing asked for a line ability.
 *
 * These render the real panel and click the real button. What needs a DOM is the wiring: that a tap
 * opens the prompt, that a granted approval applies the edit, and that a refusal changes nothing.
 */

const TAX = makeTax({ id: 1, amount: '0', tax_group_id: 1 });
const VARIANT = 101;
const PRICE_OVERRIDE = 'line.price_override';
const ABOVE_LIMIT = 'line.discount.above_limit';

let configId = 9700;
let db: PosDb;

async function verifier(deviceKey: CryptoKey, id: number, pin: string): Promise<string> {
    return hmacHex(deviceKey, `pin:${id}:${await sha256Hex(pin)}`);
}

/** A till where the cashier may not price, and may discount only up to 30 %. */
async function install(overrides: Record<string, unknown> = {}): Promise<void> {
    const deviceKey = await importDeviceKey('device-secret');

    installCatalog({
        config: makeConfig({ restrict_price_control: true, discount_limit_percent: '30', ...overrides }),
        taxes: [TAX],
        products: [makeProduct({ id: 1, name: 'Wine', list_price: '10.00', tax_ids: [TAX.id] })],
        variants: [makeVariant({ id: VARIANT, product_id: 1, display_name: 'Wine' })],
        employees: [
            makeEmployee({
                id: 2,
                name: 'Manon',
                abilities: [PRICE_OVERRIDE, ABOVE_LIMIT],
                has_pin: true,
                pin_verifier: await verifier(deviceKey, 2, '9999'),
            }),
        ],
    });

    setRuntime({ db, deviceKey } as unknown as RegisterRuntime);
}

/** Render the numpad and the approval prompt together — the manager types into the prompt. */
function panel() {
    return render(
        <>
            <NumpadPanel />
            <ApprovalDialog />
        </>,
    );
}

/** A cashier who may discount up to the cap, and nothing beyond it — the ordinary case. */
function signInCashier(abilities: string[] = ['line.discount']): void {
    useSessionStore.setState({
        cashier: { employee_id: 7, name: 'Amina B.', role: 'cashier', abilities, since: 0 } as never,
        locked: false,
    });
}

async function selectedLine(): Promise<string> {
    const uuid = await createOrder();
    useOrderStore.getState().selectOrder(uuid);
    const lineUuid = addLine({ orderUuid: uuid, variantId: VARIANT });
    useOrderStore.getState().selectLine(lineUuid);

    return lineUuid;
}

/**
 * `NumPad` holds each digit for `scannerGuardMs` (30 by default) so a barcode burst cannot become a
 * quantity of five trillion. A test that taps faster than that loses every digit but the first —
 * which is what a scanner looks like. `NumPad.test.tsx` passes `scannerGuardMs={0}`; nothing
 * constructed inside a panel can, so these wait it out instead.
 */
async function tap(scope: ReturnType<typeof within>, ...labels: string[]): Promise<void> {
    for (const label of labels) {
        await userEvent.click(scope.getByRole('button', { name: label }));
        await new Promise((resolve) => setTimeout(resolve, 45));
    }
}

/** Digits on the numpad itself — the approval dialog has its own, so both need scoping. */
async function tapNumpad(...digits: string[]): Promise<void> {
    await tap(within(screen.getByTestId('numpad')), ...digits);
}

/** The manager's half of the exchange, inside the prompt. */
async function approveAs(pin: string): Promise<void> {
    const prompt = within(screen.getByRole('dialog'));

    await userEvent.click(prompt.getByRole('button', { name: /Manon/i }));
    await tap(prompt, ...pin.split(''));
    await userEvent.click(prompt.getByRole('button', { name: /Confirm|Confirmer/i }));

    // The handler behind Confirm is async — it verifies the PIN, writes the approval row and
    // resolves the pending request. `click` returns before any of that, so an assertion made
    // straight after would read the state as it was before the manager said yes.
    await waitFor(() => {
        const settled =
            useUiStore.getState().dialog === null || screen.queryByText(/Approval refused|Validation refusée/i) !== null;

        expect(settled).toBe(true);
    });
}

beforeEach(async () => {
    configId += 1;
    resetRegisterState();
    useUiStore.setState({ dialog: null, lineApprovals: {}, numpadMode: 'quantity', buffer: '' });
    configureOrderActions({ enqueue: vi.fn(), persist: vi.fn(), onChange: vi.fn() });
    signInCashier();
    db = new PosDb(configId);
    await install();
});

afterEach(async () => {
    clearRuntime();
    db.close();
    await Dexie.delete(dbNameFor(configId));
});

describe('a price the cashier may not set', () => {
    it('offers the price mode as a question rather than a dead button', async () => {
        await selectedLine();
        panel();

        const price = screen.getByTestId('numpad-mode-price');

        // Not disabled — the old behaviour was a disabled button with a `title` nobody on a tablet
        // can see, which reads as the till ignoring the tap.
        expect(price).not.toBeDisabled();
        expect(price.textContent).toContain('🔒');
    });

    it('opens the manager prompt instead of switching mode', async () => {
        await selectedLine();
        panel();

        await userEvent.click(screen.getByTestId('numpad-mode-price'));

        expect(useUiStore.getState().dialog?.kind).toBe('approval');
        expect(useUiStore.getState().numpadMode).toBe('quantity');
    });

    it('switches to price mode once a manager approves', async () => {
        const lineUuid = await selectedLine();
        panel();

        await userEvent.click(screen.getByTestId('numpad-mode-price'));
        await approveAs('9999');

        expect(useUiStore.getState().numpadMode).toBe('price');
        expect(useUiStore.getState().lineApprovals[lineUuid]).toContain(PRICE_OVERRIDE);
    });

    it('records the approval against that line and no other', async () => {
        // The server enforces this on ingest (BAN-515); the client has to *name* the line for it to
        // have anything to enforce.
        const lineUuid = await selectedLine();
        panel();

        await userEvent.click(screen.getByTestId('numpad-mode-price'));
        await approveAs('9999');

        const [row] = await db.approvals.toArray();

        expect(row?.ability).toBe(PRICE_OVERRIDE);
        expect(row?.context).toEqual({ line_uuid: lineUuid });
    });

    it('changes nothing when the manager is refused', async () => {
        const lineUuid = await selectedLine();
        panel();

        await userEvent.click(screen.getByTestId('numpad-mode-price'));
        await approveAs('1234'); // wrong PIN — not all zeros, which the pad would collapse to one digit

        expect(useUiStore.getState().numpadMode).toBe('quantity');
        expect(useUiStore.getState().lineApprovals[lineUuid]).toBeUndefined();
        expect(await db.approvals.count()).toBe(0);
    });

    it('asks nothing at all on a register that does not restrict prices', async () => {
        await install({ restrict_price_control: false });
        await selectedLine();
        panel();

        await userEvent.click(screen.getByTestId('numpad-mode-price'));

        expect(useUiStore.getState().dialog).toBeNull();
        expect(useUiStore.getState().numpadMode).toBe('price');
    });
});

describe('a discount past the house limit', () => {
    it('holds the line at the limit and offers the ask', async () => {
        const lineUuid = await selectedLine();
        panel();

        useUiStore.setState({ numpadMode: 'discount' });
        await tapNumpad('9', '0');

        // Clamped, not refused: refusing leaves the cashier retyping a number the till will never
        // take, and applying it would be a lie the server corrects after the sale.
        expect(useOrderStore.getState().lines[lineUuid]?.discount_percent).toBe('30');
        expect(screen.getByTestId('discount-over-limit')).toBeTruthy();
    });

    it('applies the full discount once a manager approves it', async () => {
        const lineUuid = await selectedLine();
        panel();

        useUiStore.setState({ numpadMode: 'discount' });
        await tapNumpad('9', '0');
        await userEvent.click(screen.getByTestId('ask-manager-discount'));
        await approveAs('9999');

        expect(useOrderStore.getState().lines[lineUuid]?.discount_percent).toBe('90');
        expect(useUiStore.getState().lineApprovals[lineUuid]).toContain(ABOVE_LIMIT);
    });

    it('leaves the line at the limit when the manager is refused', async () => {
        const lineUuid = await selectedLine();
        panel();

        useUiStore.setState({ numpadMode: 'discount' });
        await tapNumpad('9', '0');
        await userEvent.click(screen.getByTestId('ask-manager-discount'));
        await approveAs('1234');

        expect(useOrderStore.getState().lines[lineUuid]?.discount_percent).toBe('30');
        expect(await db.approvals.count()).toBe(0);
    });

    it('says nothing about a discount inside the limit', async () => {
        const lineUuid = await selectedLine();
        panel();

        useUiStore.setState({ numpadMode: 'discount' });
        await tapNumpad('2', '0');

        expect(useOrderStore.getState().lines[lineUuid]?.discount_percent).toBe('20');
        expect(screen.queryByTestId('discount-over-limit')).toBeNull();
    });
});
