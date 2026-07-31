import { describe, expect, it } from 'vitest';

import type { KitchenOrder } from '../types';
import {
    URGENT_MULTIPLIER,
    elapsedSeconds,
    formatElapsed,
    isFlashingNew,
    isOpenOrder,
    summarize,
    thresholdsFor,
    urgencyOf,
} from './elapsed';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const DISPLAY = { average_prep_minutes: 10, late_threshold_minutes: 15 };

function order(partial: Partial<KitchenOrder>): KitchenOrder {
    return {
        id: 1,
        uuid: 'prep-1',
        prep_display_id: 2,
        pos_order_id: 1,
        tracking_number: '1',
        table_label: null,
        guest_count: null,
        preset_label: null,
        customer_name: null,
        order_note: null,
        state: 'pending',
        fired_at: null,
        first_started_at: null,
        ready_at: null,
        served_at: null,
        is_recalled: false,
        age_seconds: 0,
        lines: [],
        ...partial,
    };
}

describe('thresholdsFor', () => {
    it('derives amber from the average and red from the late threshold', () => {
        const t = thresholdsFor(DISPLAY);
        expect(t.warnSeconds).toBe(600);
        expect(t.lateSeconds).toBe(900);
        expect(t.urgentSeconds).toBe(Math.round(900 * URGENT_MULTIPLIER));
    });

    it('lets a stage tighten amber but never loosen it', () => {
        expect(thresholdsFor(DISPLAY, { alert_after_minutes: 4 }).warnSeconds).toBe(240);
        expect(thresholdsFor(DISPLAY, { alert_after_minutes: 30 }).warnSeconds).toBe(600);
        expect(thresholdsFor(DISPLAY, { alert_after_minutes: null }).warnSeconds).toBe(600);
    });

    it('substitutes sane defaults for missing or nonsensical config', () => {
        const t = thresholdsFor({ average_prep_minutes: 0, late_threshold_minutes: -1 });
        expect(t.warnSeconds).toBe(600);
        expect(t.lateSeconds).toBe(900);
    });

    it('never lets red land before amber', () => {
        const t = thresholdsFor({ average_prep_minutes: 20, late_threshold_minutes: 5 });
        expect(t.lateSeconds).toBeGreaterThanOrEqual(t.warnSeconds);
    });
});

describe('elapsedSeconds', () => {
    it('counts from fire time, not from order creation', () => {
        expect(elapsedSeconds(order({ fired_at: '2026-07-28T11:52:30.000Z', age_seconds: 99999 }), NOW)).toBe(450);
    });

    it('falls back to the server age when the ticket has not been fired', () => {
        expect(elapsedSeconds(order({ fired_at: null, age_seconds: 42 }), NOW)).toBe(42);
    });

    it('clamps a display clock that runs ahead of the server', () => {
        expect(elapsedSeconds(order({ fired_at: '2026-07-28T12:00:30.000Z' }), NOW)).toBe(0);
    });

    it('falls back when fired_at is unparseable', () => {
        expect(elapsedSeconds(order({ fired_at: 'not-a-date', age_seconds: 7 }), NOW)).toBe(7);
    });
});

describe('urgencyOf', () => {
    const t = thresholdsFor(DISPLAY);

    it('crosses each threshold exactly at the boundary', () => {
        expect(urgencyOf(0, t)).toBe('fresh');
        expect(urgencyOf(599, t)).toBe('fresh');
        expect(urgencyOf(600, t)).toBe('warning');
        expect(urgencyOf(899, t)).toBe('warning');
        expect(urgencyOf(900, t)).toBe('late');
        expect(urgencyOf(1349, t)).toBe('late');
        expect(urgencyOf(1350, t)).toBe('urgent');
    });
});

describe('formatElapsed', () => {
    it('renders m:ss under an hour and h:mm:ss above', () => {
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(9)).toBe('0:09');
        expect(formatElapsed(605)).toBe('10:05');
        expect(formatElapsed(3600)).toBe('1:00:00');
        expect(formatElapsed(3725)).toBe('1:02:05');
    });

    it('never renders a negative clock', () => {
        expect(formatElapsed(-5)).toBe('0:00');
    });
});

describe('summarize', () => {
    const t = thresholdsFor(DISPLAY);

    it('reports zeroes for an empty board', () => {
        expect(summarize([], NOW, t)).toEqual({
            openCount: 0,
            oldestSeconds: 0,
            averageSeconds: 0,
            lateCount: 0,
            urgentCount: 0,
        });
    });

    it('averages open cards only', () => {
        const summary = summarize(
            [
                order({ id: 1, fired_at: '2026-07-28T11:58:00.000Z' }), // 120 s
                order({ id: 2, fired_at: '2026-07-28T11:54:00.000Z' }), // 360 s
                order({ id: 3, state: 'served', fired_at: '2026-07-28T10:00:00.000Z' }),
            ],
            NOW,
            t,
        );
        expect(summary.openCount).toBe(2);
        expect(summary.averageSeconds).toBe(240);
        expect(summary.oldestSeconds).toBe(360);
    });

    it('counts urgent cards inside the late count', () => {
        const summary = summarize(
            [
                order({ id: 1, fired_at: '2026-07-28T11:40:00.000Z' }), // 20 min → late
                order({ id: 2, fired_at: '2026-07-28T11:30:00.000Z' }), // 30 min → urgent
            ],
            NOW,
            t,
        );
        expect(summary.lateCount).toBe(2);
        expect(summary.urgentCount).toBe(1);
    });

    it('excludes cancelled cards from the load', () => {
        expect(summarize([order({ state: 'cancelled' })], NOW, t).openCount).toBe(0);
    });
});

describe('isOpenOrder', () => {
    it('treats served and cancelled as closed', () => {
        expect(isOpenOrder({ state: 'pending' })).toBe(true);
        expect(isOpenOrder({ state: 'ready' })).toBe(true);
        expect(isOpenOrder({ state: 'served' })).toBe(false);
        expect(isOpenOrder({ state: 'cancelled' })).toBe(false);
    });
});

describe('isFlashingNew', () => {
    it('flashes only inside the window and never for an unknown arrival', () => {
        expect(isFlashingNew(NOW - 1_000, NOW)).toBe(true);
        expect(isFlashingNew(NOW - 20_000, NOW)).toBe(false);
        expect(isFlashingNew(undefined, NOW)).toBe(false);
    });
});
