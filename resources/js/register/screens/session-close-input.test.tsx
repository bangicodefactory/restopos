/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeConfig, resetRegisterState } from '../domain/__fixtures__/catalog';
import { usePosSessionStore, type ClosingData } from '../state/session-store';
import { SessionScreen } from './SessionScreen';

/**
 * BAN-507 — what the close screen sends for a per-method count.
 *
 * The server refuses anything bcmath cannot read, which is right and is not negotiable here. What
 * *is* negotiable is whether the till hands it something unreadable in the first place: the venue is
 * a French-Moroccan bistro, and a decimal keypad here produces `12,50`. Typed into a raw input that
 * went straight to the wire, so an untouched close succeeded and an edited one was refused outright.
 */

const CARD = 2;

const CLOSING: ClosingData = {
    session_id: 1,
    opening_balance: '100.0000',
    cash_in: '0.0000',
    cash_out: '0.0000',
    expected_cash: '100.0000',
    payment_totals: [
        {
            payment_method_id: CARD,
            name: 'Carte',
            is_cash_count: false,
            expected_amount: '24.2000',
            payment_count: 1,
            refund_amount: '0.0000',
            change_amount: '0.0000',
        },
    ],
    order_count: 1,
    draft_order_count: 0,
    amount_authorized_diff: '0',
    enforces_maximum_difference: false,
};

function runtime() {
    const post = vi.fn().mockResolvedValue({ data: null });

    setRuntime({
        api: { get: vi.fn().mockResolvedValue({ data: CLOSING }), post },
        db: { sessions: { toArray: () => Promise.resolve([]) } },
        // Since BAN-425 the close drains first; without a syncer it never reaches the request.
        syncer: {
            stats: vi.fn().mockResolvedValue({
                total: 0, pending: 0, inflight: 0, error: 0, quarantined: 0,
                oldestAgeMs: 0, blocksSessionClose: false,
            }),
            drain: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
        },
    } as never);

    return post;
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    usePosSessionStore.setState((state) => ({
        ...state,
        session: { id: 1, state: 'opened' } as never,
        closingData: CLOSING,
        error: null,
    }));
    installCatalog({ config: makeConfig() });
});

/** The per-method field, found by the value it pre-fills with. */
function methodField(): HTMLInputElement {
    return screen.getByDisplayValue('24.2000') as HTMLInputElement;
}

it('turns a decimal comma into something the server can read', async () => {
    const post = runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    const field = methodField();
    await userEvent.clear(field);
    await userEvent.type(field, '12,50');

    expect(field.value).toBe('12.50');

    await userEvent.click(screen.getByRole('button', { name: /close session/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]?.counted_by_method[CARD]).toBe('12.50');
});

it('strips the grouping separators a cashier reads off a terminal slip', async () => {
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    const field = methodField();
    await userEvent.clear(field);
    await userEvent.type(field, '1 250,00');

    expect(field.value).toBe('1250.00');
});

it('refuses to build a second decimal point out of a second separator', async () => {
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    const field = methodField();
    await userEvent.clear(field);
    await userEvent.type(field, '12.5.7');

    expect(field.value).toBe('12.57');
});

it('leaves an ordinary dotted amount exactly as typed', async () => {
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    const field = methodField();
    await userEvent.clear(field);
    await userEvent.type(field, '24.20');

    expect(field.value).toBe('24.20');
});

/**
 * BAN-514 — the force checkbox has to be offered for drafts this till cannot see.
 *
 * The pane counted drafts out of the local order store alone. A draft left open on a *sibling* till
 * on the same register is not in that store, so the pane showed none, hid the force checkbox, and
 * the server refused the close over an order the cashier had no way to acknowledge — a dead end at
 * the one moment the drawer is already counted.
 */
it('offers the force checkbox for a draft only the server knows about', async () => {
    runtime();

    usePosSessionStore.setState((state) => ({
        ...state,
        // Nothing in this till's own store; one open on a sibling.
        closingData: { ...CLOSING, draft_order_count: 1 },
    }));

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    expect(screen.getByRole('checkbox')).toBeTruthy();
    // And the close is gated behind it, rather than posting into a refusal.
    expect((screen.getByRole('button', { name: /close session/i }) as HTMLButtonElement).disabled).toBe(true);
});

it('leaves an ordinary close free of it', async () => {
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    expect(screen.queryByRole('checkbox')).toBeNull();
    // Waited for rather than read on first paint: the screen fetches closing data on mount and the
    // button is disabled while that is in flight, so an immediate read tests the spinner.
    await waitFor(() =>
        expect((screen.getByRole('button', { name: /close session/i }) as HTMLButtonElement).disabled).toBe(false),
    );
});
