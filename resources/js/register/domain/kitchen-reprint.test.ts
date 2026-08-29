import type { EscPosDoc } from '@domain/escpos/index';
import type { PrintJob, PrinterBinding, PrintOutcome, RouterEvent } from '@shared/printing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import { installCatalog, makeCategory, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { makeLine, resetRowSequences } from './__fixtures__/rows';
import { computePrepDelta } from './kitchen-delta';
import {
    explicitReprint,
    forgetLastPrints,
    hasReprintablePrep,
    rememberSnapshotVersion,
    sendToKitchen,
    summariseSend,
    unsentChangeCount,
} from './kitchen-send';
import { addLine, createOrder, prepKeyOf } from './order-actions';

/**
 * Explicit reprint (KDS-059, REG-297) and the per-category send toast (KDS-061) — BAN-436a.
 *
 * Neither existed. `explicitReprint` appeared in no file at all and nothing retained the rendered
 * prep documents, so a jammed printer lost the ticket outright; and `changeCountsByCategory()` had
 * been sitting in `kitchen-delta.ts` since RST-144, documented and unit tested, with zero
 * production callers, while the send toast said nothing but "Sent".
 *
 * The property that matters most here is negative: **a reprint must not re-fire the kitchen.** By
 * the time a jam is noticed the delta has been consumed, so anything that recomputes it prints a
 * blank ticket, and anything that re-sends it puts food on the pass twice.
 */

const FOOD = 10;
const DRINK = 20;
const PIZZA = 101;

let post: ReturnType<typeof vi.fn>;
let enqueued: Array<{ doc: EscPosDoc; printerId: string | undefined }>;
let printOk: boolean;

function binding(id: string, categoryIds: number[] = []): PrinterBinding {
    return {
        id,
        name: `Prep ${id}`,
        role: 'prep',
        categoryIds,
        allCategories: categoryIds.length === 0,
        transport: 'browser',
        address: '',
        eposDeviceId: null,
        profile: 'generic',
        enabled: true,
        status: { online: true, paper: 'unknown', cover: 'unknown', checkedAt: 0 },
    };
}

/**
 * A router that records what it was handed and settles on the next microtask.
 *
 * Asynchronous on purpose: `print()` subscribes *after* `enqueue` returns, so a fake that resolved
 * synchronously would settle a job nobody was listening for and every await here would hang.
 */
function fakeRouter(bindings: PrinterBinding[]) {
    const listeners = new Set<(event: RouterEvent) => void>();
    let seq = 0;

    return {
        getBindings: () => bindings,
        subscribe(listener: (event: RouterEvent) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        enqueue(doc: EscPosDoc, options: { printerId?: string } = {}) {
            seq += 1;
            const job = { id: `job-${seq}`, doc, role: 'prep', createdAt: 0 } as unknown as PrintJob;
            enqueued.push({ doc, printerId: options.printerId });

            queueMicrotask(() => {
                const outcome = {
                    ok: printOk,
                    transport: 'browser',
                    printerId: options.printerId ?? '',
                    ...(printOk ? {} : { error: { kind: 'offline', message: 'jam', retryable: true } }),
                } as unknown as PrintOutcome;

                for (const listener of listeners) {
                    listener({ type: printOk ? 'job:done' : 'job:failed', job, outcome, attempts: 1 } as RouterEvent);
                }
            });

            return job;
        },
    };
}

function installRuntime(bindings: PrinterBinding[]): void {
    post = vi.fn(async () => ({ data: { snapshot_version: 7 }, status: 200, etag: null, notModified: false }));

    setRuntime({
        api: { post, get: vi.fn() },
        syncer: { enqueueCommand: vi.fn(async () => undefined) },
        printer: fakeRouter(bindings),
    } as unknown as RegisterRuntime);
}

beforeEach(() => {
    resetRegisterState();
    resetRowSequences();
    forgetLastPrints();
    rememberSnapshotVersion('reset', 0);
    enqueued = [];
    printOk = true;

    installCatalog({
        categories: [makeCategory({ id: FOOD, name: 'Plats' }), makeCategory({ id: DRINK, name: 'Boissons' })],
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00', pos_category_ids: [FOOD] })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
    installRuntime([binding('p1')]);
});

afterEach(() => {
    clearRuntime();
    forgetLastPrints();
    vi.unstubAllGlobals();
});

describe('summariseSend (KDS-061)', () => {
    const delta = (...lines: ReturnType<typeof makeLine>[]) => computePrepDelta(lines, [], null);

    it('names each category and counts what was sent to it', () => {
        const summary = summariseSend(
            delta(
                makeLine({ pos_category_id: FOOD, quantity: 3 }),
                makeLine({ pos_category_id: DRINK, quantity: 2 }),
            ),
        );

        expect(summary).toEqual([
            { categoryId: FOOD, name: 'Plats', count: 3 },
            { categoryId: DRINK, name: 'Boissons', count: 2 },
        ]);
    });

    it('sums several lines of one category into a single entry', () => {
        const summary = summariseSend(
            delta(
                makeLine({ pos_category_id: DRINK, quantity: 2 }),
                makeLine({ pos_category_id: DRINK, quantity: 4 }),
            ),
        );

        expect(summary).toEqual([{ categoryId: DRINK, name: 'Boissons', count: 6 }]);
    });

    it('puts the biggest count first', () => {
        const summary = summariseSend(
            delta(
                makeLine({ pos_category_id: FOOD, quantity: 1 }),
                makeLine({ pos_category_id: DRINK, quantity: 8 }),
            ),
        );

        expect(summary.map((entry) => entry.categoryId)).toEqual([DRINK, FOOD]);
    });

    it('drops a bucket that totals zero rather than telling a cashier "0 x Boissons"', () => {
        // Reachable, though it looks as though it should not be. `computePrepDelta` guards
        // `delta !== 0` on a quantity change and `quantity !== 0` on a new line — but the
        // note-update site between them pushes the current quantity unconditionally. So a line
        // sitting at zero whose note was edited emits a zero-quantity change, and without the
        // guard the send toast names a category that has nothing in it.
        const line = makeLine({ pos_category_id: DRINK, quantity: 0, customer_note: 'no ice' });
        const before = { ...line, customer_note: 'with ice' };
        const snapshot = { lines: { [prepKeyOf(before)]: 2 } } as never;

        const changes = computePrepDelta([line], [], snapshot);

        // The zero-quantity note_update really is produced — if this stops being true the guard
        // above is dead and the comment on it is wrong.
        expect(changes.changes.some((c) => c.changeType === 'note_update' && c.quantity === 0)).toBe(true);
        expect(summariseSend(changes)).toEqual([]);
    });

    it('leaves the name empty for a product in no category, for the caller to localise', () => {
        // A bare category id in a toast is worse than no label at all.
        const summary = summariseSend(delta(makeLine({ pos_category_id: null, quantity: 2 })));

        expect(summary).toEqual([{ categoryId: null, name: '', count: 2 }]);
    });

    it('leaves the name empty for a category this till has never heard of', () => {
        const summary = summariseSend(delta(makeLine({ pos_category_id: 999, quantity: 1 })));

        expect(summary).toEqual([{ categoryId: 999, name: '', count: 1 }]);
    });

    it('counts a cancellation as work, not as a negative that hides it', () => {
        // `nbrOfChanges` is absolute for the same reason: "1 Plats" is what changed, and a toast
        // that netted a removal against an addition to zero would report a send that did nothing.
        const before = makeLine({ pos_category_id: FOOD, quantity: 2 });
        // `prepKeyOf`, not a hand-rolled string: the snapshot key is uuid+note joined by a
        // separator this module owns, and a key the delta engine does not recognise would silently
        // turn this into "one new line plus one orphan cancellation" — a green test of nothing.
        const snapshot = { at: '2026-07-28T12:00:00.000Z', lines: { [prepKeyOf(before)]: 2 }, noteHash: '' };
        const summary = summariseSend(computePrepDelta([{ ...before, quantity: 1 }], [], snapshot));

        expect(summary).toEqual([{ categoryId: FOOD, name: 'Plats', count: 1 }]);
    });

    it('is empty for a delta with no line changes', () => {
        expect(summariseSend(computePrepDelta([], [], null))).toEqual([]);
    });

    it('reaches the send outcome', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status).toBe('sent');
        // The wire that was missing: the counts existed, nothing carried them out of the domain.
        expect(outcome.status === 'sent' && outcome.summary.length).toBeGreaterThan(0);
    });
});

describe('explicitReprint (KDS-059)', () => {
    async function sentOrder(): Promise<string> {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        await sendToKitchen(orderUuid);
        enqueued = [];
        post.mockClear();

        return orderUuid;
    }

    it('refuses when this till has never rendered a ticket for the order', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });

        expect(hasReprintablePrep(orderUuid)).toBe(false);
        expect(await explicitReprint(orderUuid)).toEqual({ status: 'nothing' });
        expect(enqueued).toHaveLength(0);
    });

    it('puts the last ticket on paper again', async () => {
        const orderUuid = await sentOrder();

        expect(hasReprintablePrep(orderUuid)).toBe(true);
        const outcome = await explicitReprint(orderUuid);

        expect(outcome).toMatchObject({ status: 'reprinted', printed: 1 });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]?.printerId).toBe('p1');
    });

    it('does not re-fire the kitchen: no post, and the delta is untouched', async () => {
        // The property the whole feature turns on. A reprint that went through the send path would
        // find an empty delta and print a blank ticket — or, worse, re-send and double the order.
        const orderUuid = await sentOrder();
        const before = unsentChangeCount(orderUuid);

        await explicitReprint(orderUuid);

        expect(post).not.toHaveBeenCalled();
        expect(unsentChangeCount(orderUuid)).toBe(before);
    });

    it('does not fire a delta that has accumulated since the send', async () => {
        // The scenario the guard is really for, and the one the "no post" test above cannot see:
        // send, the printer jams, the waiter adds a dessert on the way back, *then* presses
        // reprint. With an empty delta a reprint routed through the send path is indistinguishable
        // from a correct one — it posts nothing because there is nothing to post. With a pending
        // delta it puts food on the pass that nobody confirmed, and marks it sent.
        const orderUuid = await sentOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 3 });

        expect(unsentChangeCount(orderUuid)).toBe(3);

        await explicitReprint(orderUuid);

        expect(post).not.toHaveBeenCalled();
        expect(unsentChangeCount(orderUuid)).toBe(3);
        // One document — the retained one. Two would mean the dessert printed as well.
        expect(enqueued).toHaveLength(1);
    });

    it('reprints the same document, not a freshly computed one', async () => {
        // After a send the delta is empty, so anything that rebuilt the ticket from the current
        // state would hand the kitchen a ticket with no lines on it.
        const orderUuid = await sentOrder();

        await explicitReprint(orderUuid);

        const reprinted = enqueued[0]?.doc;
        expect(reprinted).toBeDefined();
        expect(reprinted?.meta.kind).toBe('prep');
        expect(reprinted?.nodes.length).toBeGreaterThan(1);
    });

    it('marks the paper as a duplicate so a cook cannot read it as a second order', async () => {
        const orderUuid = await sentOrder();

        await explicitReprint(orderUuid);
        const first = enqueued[0]?.doc;

        expect(first?.meta.copy).toBe(2);
        expect(first?.nodes[0]).toMatchObject({ t: 'text', v: 'DUPLICATA' });

        enqueued = [];
        await explicitReprint(orderUuid);

        expect(enqueued[0]?.doc.meta.copy).toBe(3);
    });

    it('stays reprintable when the original print failed — the jam is the whole point', async () => {
        // Retention happens on *render*, not on a successful print. Retaining only successes would
        // leave nothing to reprint in exactly the cases a reprint exists for.
        printOk = false;
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        const outcome = await sendToKitchen(orderUuid);

        expect(outcome.status === 'sent' && outcome.printed).toBe(0);
        expect(hasReprintablePrep(orderUuid)).toBe(true);

        printOk = true;
        enqueued = [];

        expect(await explicitReprint(orderUuid)).toMatchObject({ status: 'reprinted', printed: 1 });
    });

    it('reports a reprint that did not come out', async () => {
        const orderUuid = await sentOrder();
        printOk = false;

        expect(await explicitReprint(orderUuid)).toMatchObject({ status: 'reprinted', printed: 0 });
    });

    it('retains the newest send, not the first', async () => {
        const orderUuid = await sentOrder();
        addLine({ orderUuid, variantId: PIZZA, quantity: 5 });
        await sendToKitchen(orderUuid);
        enqueued = [];

        await explicitReprint(orderUuid);

        // Copy numbering restarts with each send: this is the first duplicate of the second ticket.
        expect(enqueued[0]?.doc.meta.copy).toBe(2);
        expect(enqueued).toHaveLength(1);
    });

    it('keeps one document per bound prep printer', async () => {
        installRuntime([binding('p1'), binding('p2')]);
        const orderUuid = await sentOrder();

        const outcome = await explicitReprint(orderUuid);

        expect(outcome).toMatchObject({ status: 'reprinted', printed: 2 });
        expect(enqueued.map((entry) => entry.printerId)).toEqual(['p1', 'p2']);
    });

    it('does not clobber a retained ticket with a send that rendered nothing', async () => {
        // No prep printer covers this order's categories, so the send builds no document. Replacing
        // the retention with an empty set would silently disable a button the cashier needs.
        const orderUuid = await sentOrder();
        installRuntime([binding('p9', [DRINK])]);

        addLine({ orderUuid, variantId: PIZZA, quantity: 1 });
        await sendToKitchen(orderUuid);

        expect(hasReprintablePrep(orderUuid)).toBe(true);
    });

    it('forgets a ticket on demand, so a new session does not offer yesterday’s', async () => {
        const orderUuid = await sentOrder();

        forgetLastPrints(orderUuid);

        expect(hasReprintablePrep(orderUuid)).toBe(false);
        expect(await explicitReprint(orderUuid)).toEqual({ status: 'nothing' });
    });

    it('fails cleanly with no runtime rather than throwing at the cashier', async () => {
        const orderUuid = await sentOrder();
        clearRuntime();

        expect(await explicitReprint(orderUuid)).toEqual({ status: 'failed', reason: 'no_runtime' });
    });
});
