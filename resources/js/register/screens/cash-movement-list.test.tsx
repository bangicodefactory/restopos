/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { useSessionStore } from '@shared/auth';

import { clearRuntime, setRuntime } from '../data/runtime';
import { installCatalog, makeConfig, resetRegisterState } from '../domain/__fixtures__/catalog';
import { usePosSessionStore, type CashMovementRow, type ClosingData } from '../state/session-store';
import { SessionScreen } from './SessionScreen';

/**
 * BAN-420 — the drawer ledger in the closing pane (REG-011, REG-012).
 *
 * "The drawer is 40 short" and "Karim took 40 to the bank at 15:20" are the same fact told with and
 * without this list, and only one of them ends the conversation. The delete beside each row is
 * manager-gated at the server; what these cover is that the till asks for the approval at all
 * rather than firing a request that will be refused.
 */

const CLOSING: ClosingData = {
    session_id: 1,
    opening_balance: '100.0000',
    cash_in: '0.0000',
    cash_out: '-40.0000',
    expected_cash: '60.0000',
    payment_totals: [],
    order_count: 0,
    draft_order_count: 0,
    amount_authorized_diff: '0',
    enforces_maximum_difference: false,
};

const MOVEMENTS: CashMovementRow[] = [
    {
        uuid: 'move-1',
        movement_type: 'cash_out',
        amount: '-40.0000',
        reason: 'Bank run',
        employee_id: 7,
        employee_name: 'Karim M.',
        moved_at: '2026-08-07T15:20:00.000Z',
    },
    {
        // Reason is optional on the sync payload, so a movement can reach the ledger without one.
        uuid: 'move-2',
        movement_type: 'cash_in',
        amount: '25.0000',
        reason: null,
        employee_id: null,
        employee_name: null,
        moved_at: '2026-08-07T16:05:00.000Z',
    },
];

/** Sign a cashier in with exactly the abilities a test cares about. */
function signIn(abilities: string[]): void {
    useSessionStore.setState({
        cashier: {
            employee_id: 7,
            name: 'Karim M.',
            role: 'manager',
            abilities,
            since: 0,
        } as never,
        locked: false,
    });
}

function runtime() {
    const del = vi.fn().mockResolvedValue({ data: null });

    setRuntime({
        api: {
            get: vi.fn().mockImplementation((path: string) =>
                Promise.resolve({
                    data: path.endsWith('cash-movements') ? { movements: MOVEMENTS } : CLOSING,
                }),
            ),
            post: vi.fn().mockResolvedValue({ data: null }),
            delete: del,
        },
        db: { sessions: { toArray: () => Promise.resolve([]) } },
    } as never);

    return del;
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    usePosSessionStore.setState((state) => ({
        ...state,
        session: { id: 1, state: 'opened', name: 'Bar/00007' } as never,
        closingData: CLOSING,
        movements: [],
        error: null,
    }));
    installCatalog({ config: makeConfig() });
    signIn(['cash.in_out', 'cash.in_out.delete']);
});

it('shows what moved, who moved it and when', async () => {
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    expect(await screen.findByText('Bank run')).toBeTruthy();
    // Employee and clock time on one line — the two facts that turn an amount into an explanation.
    expect(screen.getByText(/Karim M\./)).toBeTruthy();
});

it('names the direction when nobody typed a reason', async () => {
    // A row with no reason and no employee would otherwise be a bare amount with a blank line under
    // it — indistinguishable from a rendering fault, on the screen where a drawer is reconciled.
    runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    await screen.findByText('Bank run');

    // Scoped to the ledger: the closing pane renders other lists, and "Cash in" is also a label on
    // the movement dialog's direction toggle.
    const ledger = screen.getByTestId('cash-movements');

    expect(within(ledger).getByText('Cash in')).toBeTruthy();
});

it('asks a manager to approve before it deletes anything', async () => {
    // The server verifies a PIN regardless; the point of asking first is that the cashier is not
    // sent a refusal they cannot act on.
    const del = runtime();

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    await screen.findByText('Bank run');
    // The first row's button: the ledger now carries two movements, and this one is Karim's.
    await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);

    // The approval dialog is now pending and nothing has been sent.
    expect(del).not.toHaveBeenCalled();
});

it('offers no delete to a cashier who does not hold the ability', async () => {
    runtime();
    signIn(['cash.in_out']);

    render(<SessionScreen mode="close" onDone={vi.fn()} />);

    // The row is still there — a cashier may *see* the ledger, they simply cannot unpick it.
    await screen.findByText('Bank run');

    expect(screen.queryAllByRole('button', { name: /remove/i })).toHaveLength(0);
});
