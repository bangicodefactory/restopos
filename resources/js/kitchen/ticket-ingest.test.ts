import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useKitchenStore } from './store';
import type { KitchenTicket } from './types';

/**
 * KDS-053 — what a broadcast ticket is allowed to do to the board (review of #58).
 *
 * BAN-500 taught the server to send a note-only amendment to the displays already showing an order.
 * The guard for "already showing" is server-side: a `prep_orders` row exists. That row outlives the
 * card on screen — once a served ticket ages past `done_retention_minutes` the board drops it, while
 * the row stays. So the amendment still goes out, to a board that is no longer holding the card.
 *
 * `ingestTicket` then took the branch for an order it does not know and built a **pending card with
 * zero items**. The pass grew a blank ticket. The server-side `hasCard` check prevents exactly this
 * for a station that never saw the order; this is the same failure through a different door.
 */
function ticket(overrides: Partial<KitchenTicket> = {}): KitchenTicket {
    return {
        prep_order_id: 42,
        prep_order_uuid: 'u-42',
        prep_display_id: 7,
        order_uuid: 'o-1',
        tracking_number: '001',
        table_label: 'T1',
        guest_count: 2,
        order_note: null,
        fired_at: '2026-08-17T10:00:00.000Z',
        lines: [],
        ...overrides,
    };
}

const LINE = {
    id: 1,
    line_id: 1,
    line_uuid: 'l-1',
    product_id: 5,
    display_name: 'Pasta',
    quantity: '1.000',
    change_type: 'new',
    customer_note: null,
    internal_note: null,
    pos_category_id: null,
    course_id: null,
    course_index: null,
    combo_parent_uuid: null,
} as unknown as KitchenTicket['lines'][number];

beforeEach(() => {
    useKitchenStore.setState({ display: { id: 7, name: 'Pass' } as never, orders: [], stages: [] });
});

describe('a ticket the board is not already holding', () => {
    it('does not create a card from a note-only amendment', () => {
        useKitchenStore.getState().ingestTicket(ticket());

        expect(useKitchenStore.getState().orders).toEqual([]);
    });

    it('still creates a card when the ticket has items', () => {
        useKitchenStore.getState().ingestTicket(ticket({ lines: [LINE] }));

        const orders = useKitchenStore.getState().orders;

        expect(orders).toHaveLength(1);
        expect(orders[0]?.lines).toHaveLength(1);
    });

    it('carries the order note onto a card it does create', () => {
        // The payload had no `order_note` at all, so even a legitimately created card showed none.
        useKitchenStore.getState().ingestTicket(ticket({ lines: [LINE], order_note: 'ALLERGY: no onions' }));

        expect(useKitchenStore.getState().orders[0]?.order_note).toBe('ALLERGY: no onions');
    });

    it('ignores a ticket addressed to another display', () => {
        useKitchenStore.getState().ingestTicket(ticket({ prep_display_id: 99, lines: [LINE] }));

        expect(useKitchenStore.getState().orders).toEqual([]);
    });
});

describe('a ticket for a card already on the board', () => {
    it('pulls the authoritative row rather than painting the amendment', () => {
        const refresh = vi.fn().mockResolvedValue(undefined);

        useKitchenStore.setState({
            orders: [{ id: 42, lines: [] } as never],
            refresh: refresh as never,
        });

        useKitchenStore.getState().ingestTicket(ticket());

        // This is the path that actually delivers a late note to a cook watching the screen: the
        // event is the nudge, `refresh()` fetches the truth.
        expect(refresh).toHaveBeenCalledOnce();
        expect(useKitchenStore.getState().orders).toHaveLength(1);
    });
});
