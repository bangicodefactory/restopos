import { classifyHttpError } from '@domain/sync/wire';
import { ApiError } from '@shared/sync';
import { beforeEach, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime } from '../data/runtime';
import { usePosSessionStore } from '../state/session-store';
import { closeSession, openSession } from './session-actions';

/**
 * BAN-417 — what the cashier is told when the server refuses.
 *
 * The gate is only half the ticket. `classifyHttpError` reads a **top-level** `message` and every
 * POS endpoint nests it under `error.message`, so a refusal used to reach the till as the literal
 * string "Validation failed" — which tells a cashier something went wrong and hides the one fact
 * that would let anyone fix it.
 *
 * The open pane's problem panel covers the case where `sessions/current` has already answered.
 * These cover the case it cannot: tapping Open before the readiness lands (the button is enabled
 * until it does, because the server is authoritative), a register whose configuration changed in
 * between, and a session already open — where there is no panel at all.
 */

/**
 * An outbox with nothing in it. Since BAN-425 `closeSession` drains before it posts, so a runtime
 * without a syncer never reaches the request these tests are about.
 */
function emptyOutbox() {
    return {
        stats: vi.fn().mockResolvedValue({
            total: 0, pending: 0, inflight: 0, error: 0, quarantined: 0,
            oldestAgeMs: 0, blocksSessionClose: false,
        }),
        drain: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
    };
}

function refusing(status: number, body: unknown) {
    const rejection = new ApiError(status, classifyHttpError(status, body as never), body);

    setRuntime({ api: { post: vi.fn().mockRejectedValue(rejection) }, syncer: emptyOutbox() } as never);
}

const NOT_READY = {
    error: {
        code: 'register_not_ready',
        message: 'This register is not configured to open a session: This register has no payment method.',
        problems: [
            { code: 'no_payment_method', message: 'This register has no payment method.' },
            { code: 'currency_mismatch', message: 'This register trades in a different currency.' },
        ],
    },
};

function shownError(): string | null {
    return usePosSessionStore.getState().error;
}

beforeEach(() => {
    clearRuntime();
    usePosSessionStore.setState((state) => ({ ...state, error: null, session: null }));
});

it('names every missing piece rather than saying "Validation failed"', async () => {
    refusing(422, NOT_READY);

    await openSession({ openingFloat: '0', employeeId: null });

    expect(shownError()).toBe('This register has no payment method. This register trades in a different currency.');
});

it('falls back to the summary when a refusal carries no problem list', async () => {
    // `session_open_failed` — a session is already open. Different fix, and one the cashier makes
    // at the till, so the sentence matters just as much.
    refusing(422, { error: { code: 'session_open_failed', message: 'This register already has an open session.' } });

    await openSession({ openingFloat: '0', employeeId: null });

    expect(shownError()).toBe('This register already has an open session.');
});

it('keeps the framework message for a plain validation failure', async () => {
    // A malformed `opening_float` is rejected by the FormRequest, which answers in Laravel's own
    // shape with a top-level `message` and no `error` key. Nothing to prefer, so nothing is taken.
    refusing(422, { message: 'The opening float field must be a valid decimal.', errors: {} });

    await openSession({ openingFloat: '1e2', employeeId: null });

    expect(shownError()).toBe('The opening float field must be a valid decimal.');
});

it('does not mistake an unrelated body for a refusal message', async () => {
    refusing(422, { error: { code: 'odd', message: '' } });

    await openSession({ openingFloat: '0', employeeId: null });

    expect(shownError()).toBe('Validation failed');
});

it('leaves the offline and auth sentinels alone', async () => {
    refusing(undefined as unknown as number, null);

    await openSession({ openingFloat: '0', employeeId: null });

    expect(shownError()).toBe('offline');
});

it('tells the cashier why a close was refused too', async () => {
    // The same helper serves every session call, so the close screen gets the fix for free — and it
    // is the screen where a wrong number is hardest to argue with after the fact.
    refusing(422, {
        error: { code: 'session_close_refused', message: 'Closing difference -10.00 exceeds the authorised 1.00.' },
    });

    const result = await closeSession({
        sessionId: 1,
        countedCash: '90.00',
        countedByMethod: {},
        employeeId: null,
    });

    expect(result.ok).toBe(false);
    expect(shownError()).toBe('Closing difference -10.00 exceeds the authorised 1.00.');
});
