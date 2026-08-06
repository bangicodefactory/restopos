import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';

import { openDrawer } from './printing';

/**
 * BAN-413 — the till's half of the drawer report.
 *
 * The drawer opens by an ESC/POS pulse sent straight from this browser to the printer, so the server
 * has no way of knowing it happened: the one money-adjacent action with no row of any kind, and
 * "the drawer was opened at 23:40 with no sale attached" is near the top of what a manager wants to
 * ask. The report is queued through the outbox rather than posted, because the openings worth
 * investigating are not the ones that happen while the network is up.
 *
 * The property that actually matters here is that **the pulse still fires**. An audit trail that can
 * stop a cashier opening the till — because the queue threw, or the runtime was not up yet — has
 * traded a working register for a better paper trail, which is the wrong way round.
 */

let enqueueCommand: ReturnType<typeof vi.fn>;
let routerOpenDrawer: ReturnType<typeof vi.fn>;

function router(): Parameters<typeof openDrawer>[0] {
    routerOpenDrawer = vi.fn(async () => null);

    return { openDrawer: routerOpenDrawer } as unknown as Parameters<typeof openDrawer>[0];
}

beforeEach(() => {
    enqueueCommand = vi.fn(async () => undefined);

    setRuntime({
        api: { post: vi.fn(), get: vi.fn() },
        syncer: { enqueueCommand },
    } as unknown as RegisterRuntime);
});

afterEach(() => {
    clearRuntime();
    vi.restoreAllMocks();
});

describe('openDrawer', () => {
    it('queues an audit batch and still opens the drawer', () => {
        return openDrawer(router(), 'cash_payment', { sessionId: 4, employeeId: 9 }).then(() => {
            expect(routerOpenDrawer).toHaveBeenCalledOnce();
            expect(enqueueCommand).toHaveBeenCalledOnce();

            const [kind, payload] = enqueueCommand.mock.calls[0] as [string, { events: unknown[] }];

            expect(kind).toBe('audit.batch');
            expect(payload.events).toHaveLength(1);
            expect(payload.events[0]).toMatchObject({
                event: 'cash.drawer.opened',
                session_id: 4,
                employee_id: 9,
                detail: { reason: 'cash_payment' },
            });
        });
    });

    it('gives each opening its own uuid', async () => {
        // Per event, not per batch: the outbox redelivers, and the server dedupes on this uuid. Two
        // openings sharing one would silently collapse into a single row — the one case where the
        // trail is wrong rather than merely incomplete.
        await openDrawer(router(), 'no_sale');
        await openDrawer(router(), 'no_sale');

        const uuids = enqueueCommand.mock.calls.map(
            (call) => (call[1] as { events: Array<{ uuid: string }> }).events[0]?.uuid,
        );

        expect(uuids[0]).toBeTruthy();
        expect(uuids[0]).not.toBe(uuids[1]);
    });

    it('carries the reason, which is what makes a no-sale findable', async () => {
        await openDrawer(router(), 'no_sale', { sessionId: 1 });

        const payload = enqueueCommand.mock.calls[0]?.[1] as { events: Array<{ detail: { reason: string } }> };

        expect(payload.events[0]?.detail.reason).toBe('no_sale');
    });

    it('opens the drawer even when the queue rejects the report', async () => {
        // The same rule as the missing runtime, from the other direction: a full or broken outbox
        // must not hold the drawer shut. Verified by rejecting, because `void`-ing a rejected
        // promise is an unhandled rejection, not a no-op.
        enqueueCommand.mockRejectedValueOnce(new Error('outbox full'));

        const printer = router();

        await openDrawer(printer, 'cash_payment', { sessionId: 1 });

        expect(routerOpenDrawer).toHaveBeenCalledOnce();
    });

    it('opens the drawer even with no runtime to report to', async () => {
        // Boot order: a till that has not finished wiring its runtime must still be able to open the
        // drawer. Reporting is the secondary concern here and has to fail soft.
        clearRuntime();

        const printer = router();

        await openDrawer(printer, 'cash_payment');

        expect(routerOpenDrawer).toHaveBeenCalledOnce();
    });
});
