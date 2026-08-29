/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_FILTER, buildBoard } from '../logic/board';
import { thresholdsFor } from '../logic/elapsed';
import type { KitchenDisplay, KitchenLine, KitchenOrder, KitchenStage } from '../types';
import { Board } from './Board';

/**
 * The `grid` branch of the board (KDS-013, BAN-436a).
 *
 * `logic/board-rollup.test.ts` proves the projection; this proves the layout actually reaches it.
 * The defect was two wires, and fixing only the first would still leave "Grille" rendering the card
 * wall — so the assertion that matters is that `grid` renders roll-up rows and **not** tickets.
 */

const STAGES: KitchenStage[] = [
    { id: 1, prep_display_id: 2, name: 'À faire', stage_type: 'todo', color: null, alert_after_minutes: null, sequence: 10 },
    { id: 2, prep_display_id: 2, name: 'En cours', stage_type: 'in_progress', color: null, alert_after_minutes: null, sequence: 20 },
];

const DISPLAY: KitchenDisplay = {
    id: 2,
    name: 'Bar',
    layout: 'grid',
    average_prep_minutes: 10,
    late_threshold_minutes: 15,
    done_retention_minutes: 60,
    sound_on_new_order: true,
};

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

let seq = 0;

function line(partial: Partial<KitchenLine> = {}): KitchenLine {
    seq += 1;
    return {
        id: seq,
        uuid: `line-${seq}`,
        pos_order_line_uuid: `pol-${seq}`,
        prep_stage_id: 1,
        course_index: null,
        product_id: 100,
        display_name: 'Frites',
        quantity: '1.000',
        change_type: 'new',
        customer_note: null,
        internal_note: null,
        state: 'todo',
        started_at: null,
        ready_at: null,
        served_at: null,
        fired_at: '2026-07-28T11:55:00.000Z',
        ...partial,
    };
}

function order(id: number, partial: Partial<KitchenOrder> = {}): KitchenOrder {
    return {
        id,
        uuid: `prep-${id}`,
        prep_display_id: 2,
        pos_order_id: 5000 + id,
        tracking_number: String(500 + id),
        table_label: 'T1',
        guest_count: 2,
        preset_label: null,
        customer_name: null,
        order_note: null,
        state: 'pending',
        fired_at: '2026-07-28T11:55:00.000Z',
        first_started_at: null,
        ready_at: null,
        served_at: null,
        is_recalled: false,
        age_seconds: 300,
        lines: [line()],
        ...partial,
    };
}

function view(orders: KitchenOrder[]) {
    return buildBoard({
        orders,
        stages: STAGES,
        filter: EMPTY_FILTER,
        categoryOf: () => null,
        thresholds: thresholdsFor(DISPLAY),
        now: NOW,
        doneRetentionMinutes: 60,
    });
}

function board(layout: 'columns' | 'grid' | 'list', orders: KitchenOrder[], onToggleLine = vi.fn()) {
    render(
        <Board
            view={view(orders)}
            display={DISPLAY}
            layout={layout}
            now={NOW}
            firstSeen={{}}
            onAdvance={vi.fn()}
            onRecall={vi.fn()}
            onComplete={vi.fn()}
            onToggleLine={onToggleLine}
        />,
    );

    return onToggleLine;
}

const ORDERS = [
    order(1, { lines: [line({ quantity: '4.000' })] }),
    order(2, { lines: [line({ quantity: '8.000' })] }),
];

describe('Board — grid layout', () => {
    it('renders one consolidated row instead of one card per order', () => {
        board('grid', ORDERS);

        expect(screen.getByRole('region', { name: '12× Frites' })).toBeInTheDocument();
        expect(screen.getAllByRole('region')).toHaveLength(1);
    });

    it('names both contributing tickets on the row', () => {
        board('grid', ORDERS);

        expect(screen.getByRole('button', { name: '501 · 4× Frites' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '502 · 8× Frites' })).toBeInTheDocument();
    });

    it('ticks a single ticket off from the roll-up', () => {
        // The chips are the layout's only affordance; without them the roll-up is a poster and a
        // cook has to switch layouts to bump anything.
        const onToggleLine = board('grid', ORDERS);

        return userEvent.click(screen.getByRole('button', { name: '501 · 4× Frites' })).then(() => {
            expect(onToggleLine).toHaveBeenCalledWith(1, ORDERS[0]!.lines[0]!.id);
        });
    });

    it('shows a note rather than folding it into the total', () => {
        board('grid', [
            order(1, { lines: [line({ quantity: '2.000' })] }),
            order(2, { lines: [line({ quantity: '1.000', customer_note: 'sans sel' })] }),
        ]);

        expect(screen.getAllByRole('region')).toHaveLength(2);
        expect(screen.getByText('sans sel')).toBeInTheDocument();
    });

    it('says so when the board holds cards but owes no items', () => {
        // A note-only ticket is an open card with nothing to make. An empty pane would read as a
        // crashed screen on a wall.
        board('grid', [order(1, { lines: [], order_note: 'allergie noix' })]);

        expect(screen.getByText('Rien à préparer')).toBeInTheDocument();
    });

    it('still renders the empty-board message when there is nothing at all', () => {
        board('grid', []);

        expect(screen.getByText('Rien à préparer')).toBeInTheDocument();
    });
});

describe('Board — the other two layouts are untouched', () => {
    it('columns renders stage columns, not roll-up rows', () => {
        board('columns', ORDERS);

        expect(screen.getByRole('region', { name: 'À faire' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: '12× Frites' })).not.toBeInTheDocument();
    });

    it('list renders cards, not roll-up rows', () => {
        board('list', ORDERS);

        expect(screen.queryByRole('region', { name: '12× Frites' })).not.toBeInTheDocument();
        expect(screen.getByText('501')).toBeInTheDocument();
        expect(screen.getByText('502')).toBeInTheDocument();
    });
});
