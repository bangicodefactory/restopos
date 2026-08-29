/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BoardScreen } from './App';
import { EMPTY_FILTER } from './logic/board';
import { DEFAULT_PREFS } from './persistence';
import { useKitchenStore } from './store';
import type { KitchenDisplay, KitchenLine, KitchenOrder, KitchenStage } from './types';

/**
 * The screen honours the layout the back office configured (KDS-013, BAN-436a).
 *
 * This is the test that covers the actual defect. `boardLayoutOf` and `nextLayout` are pure and
 * tested next door, but the bug was never in a helper — it was a component quietly deciding that
 * `grid` meant `columns`, and a toggle that could only name two of three layouts. A unit test of a
 * helper cannot catch a caller that stops calling it, so this renders the screen and looks at what
 * a cook would actually see.
 */

const STAGES: KitchenStage[] = [
    { id: 1, prep_display_id: 2, name: 'À faire', stage_type: 'todo', color: null, alert_after_minutes: null, sequence: 10 },
];

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

const LINE: KitchenLine = {
    id: 1,
    uuid: 'line-1',
    pos_order_line_uuid: 'pol-1',
    prep_stage_id: 1,
    course_index: null,
    product_id: 100,
    display_name: 'Frites',
    quantity: '4.000',
    change_type: 'new',
    customer_note: null,
    internal_note: null,
    state: 'todo',
    started_at: null,
    ready_at: null,
    served_at: null,
    fired_at: '2026-07-28T11:55:00.000Z',
};

const ORDER: KitchenOrder = {
    id: 1,
    uuid: 'prep-1',
    prep_display_id: 2,
    pos_order_id: 5001,
    tracking_number: '501',
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
    lines: [LINE],
};

function config(layout: string): KitchenDisplay {
    return {
        id: 2,
        name: 'Bar',
        layout,
        average_prep_minutes: 10,
        late_threshold_minutes: 15,
        done_retention_minutes: 60,
        sound_on_new_order: true,
    };
}

let updatePrefs: ReturnType<typeof vi.fn>;

function install(displayLayout: string, prefLayout: 'columns' | 'grid' | 'list' | null = null): void {
    updatePrefs = vi.fn();

    useKitchenStore.setState({
        phase: 'ready',
        display: { token: 't', id: 2, name: 'Bar' },
        displayConfig: config(displayLayout),
        stages: STAGES,
        orders: [ORDER],
        categories: [],
        productCategory: {},
        queue: [],
        prefs: { ...DEFAULT_PREFS, layout: prefLayout },
        online: true,
        degraded: false,
        realtime: 'connected',
        lastSyncAt: NOW,
        firstSeen: {},
        alert: null,
        updatePrefs,
    });
}

function paint(): void {
    render(<BoardScreen filter={EMPTY_FILTER} onFilter={vi.fn()} now={NOW} />);
}

beforeEach(() => {
    install('columns');
});

describe('BoardScreen honours the configured layout', () => {
    it('renders the roll-up for a display configured as grid', () => {
        // The defect, exactly: `display.layout === 'list' ? 'list' : 'columns'` sent a Grille
        // screen to the card wall, and nothing anywhere told the operator their choice was dropped.
        install('grid');
        paint();

        expect(screen.getByRole('region', { name: '4× Frites' })).toBeInTheDocument();
    });

    it('renders stage columns for a display configured as columns', () => {
        install('columns');
        paint();

        expect(screen.getByRole('region', { name: 'À faire' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: '4× Frites' })).not.toBeInTheDocument();
    });

    it('falls back to columns for a layout string it does not know', () => {
        install('kanban');
        paint();

        expect(screen.getByRole('region', { name: 'À faire' })).toBeInTheDocument();
    });

    it('lets the operator’s own choice override the configured layout', () => {
        install('columns', 'grid');
        paint();

        expect(screen.getByRole('region', { name: '4× Frites' })).toBeInTheDocument();
    });
});

describe('the layout toggle reaches all three', () => {
    it('offers list from columns', async () => {
        install('columns');
        paint();

        // Text as well as accessible name: the button labels the layout it moves *to*, and a
        // version that named the current one instead kept the same aria-label — so an assertion on
        // the role name alone passes while a cook reads the wrong word on the glass.
        const button = screen.getByRole('button', { name: 'Liste' });
        expect(button).toHaveTextContent('Liste');

        await userEvent.click(button);

        expect(updatePrefs).toHaveBeenCalledWith({ layout: 'list' });
    });

    it('offers grid from list — the step that did not exist', async () => {
        install('list');
        paint();

        const button = screen.getByRole('button', { name: 'Grille' });
        expect(button).toHaveTextContent('Grille');

        await userEvent.click(button);

        expect(updatePrefs).toHaveBeenCalledWith({ layout: 'grid' });
    });

    it('returns to columns from grid', async () => {
        install('grid');
        paint();

        const button = screen.getByRole('button', { name: 'Colonnes' });
        expect(button).toHaveTextContent('Colonnes');

        await userEvent.click(button);

        expect(updatePrefs).toHaveBeenCalledWith({ layout: 'columns' });
    });
});
