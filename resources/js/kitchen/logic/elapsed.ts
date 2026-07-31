import type { KitchenDisplay, KitchenOrder, KitchenStage } from '../types';

/**
 * Age, urgency and station load (KDS-011, KDS-022).
 *
 * Two rules from the spec that the implementation has to get right:
 *
 *   1. **The clock starts at fire time, not at order creation.** A starter fired at 19:02 and a
 *      main fired at 19:31 are two different ages on the same tab, and a cook judging the pass by
 *      "when the customer sat down" will plate everything at once.
 *   2. **The client re-derives the age from `fired_at`.** The board endpoint ships `age_seconds`,
 *      but that number is stale the moment it is serialised and it is wrong by however long the
 *      screen was offline. `age_seconds` is only used as a fallback when `fired_at` is null.
 *
 * Nothing here touches `Date.now()` implicitly: `now` is always a parameter, which is what makes
 * the whole module testable without fake timers.
 */

export type UrgencyLevel = 'fresh' | 'warning' | 'late' | 'urgent';

export type UrgencyThresholds = {
    /** Amber. Defaults to the display's `average_prep_minutes`. */
    warnSeconds: number;
    /** Red. The display's `late_threshold_minutes`. */
    lateSeconds: number;
    /** Flashing red — "walk over and look at this". */
    urgentSeconds: number;
};

/** Past this multiple of the late threshold a ticket is not merely late, it has been forgotten. */
export const URGENT_MULTIPLIER = 1.5;

const MINUTE = 60;

/**
 * Resolve the colour thresholds for a card.
 *
 * A stage may tighten the amber threshold through `alert_after_minutes` — the fryer wants to shout
 * sooner than the pass does. It may never loosen the late threshold: that one is the venue's
 * service promise and belongs to the display.
 */
export function thresholdsFor(
    display: Pick<KitchenDisplay, 'average_prep_minutes' | 'late_threshold_minutes'>,
    stage?: Pick<KitchenStage, 'alert_after_minutes'> | null,
): UrgencyThresholds {
    const averageMinutes = positive(display.average_prep_minutes, 10);
    const lateMinutes = positive(display.late_threshold_minutes, 15);

    const stageAlert = stage?.alert_after_minutes;
    const warnMinutes =
        typeof stageAlert === 'number' && stageAlert > 0 ? Math.min(stageAlert, averageMinutes) : averageMinutes;

    const lateSeconds = Math.max(lateMinutes * MINUTE, warnMinutes * MINUTE);

    return {
        warnSeconds: warnMinutes * MINUTE,
        lateSeconds,
        urgentSeconds: Math.round(lateSeconds * URGENT_MULTIPLIER),
    };
}

function positive(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Seconds since the ticket was fired.
 *
 * Returns the server's `age_seconds` when there is no `fired_at` (a card that exists but has not
 * been fired yet — a held course), and never returns a negative number: a display whose clock runs
 * a few seconds ahead of the server must not render "-3s".
 */
export function elapsedSeconds(
    order: Pick<KitchenOrder, 'fired_at' | 'age_seconds'>,
    now: number,
): number {
    if (order.fired_at) {
        const fired = Date.parse(order.fired_at);
        if (Number.isFinite(fired)) return Math.max(0, Math.floor((now - fired) / 1000));
    }
    return Math.max(0, Math.floor(order.age_seconds ?? 0));
}

export function urgencyOf(seconds: number, thresholds: UrgencyThresholds): UrgencyLevel {
    if (seconds >= thresholds.urgentSeconds) return 'urgent';
    if (seconds >= thresholds.lateSeconds) return 'late';
    if (seconds >= thresholds.warnSeconds) return 'warning';
    return 'fresh';
}

/** `m:ss` under an hour, `h:mm:ss` above it. Monospace-friendly, readable at three metres. */
export function formatElapsed(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export type StationSummary = {
    /** Cards still needing work — anything not served and not cancelled. */
    openCount: number;
    /** Age of the oldest open card, in seconds. */
    oldestSeconds: number;
    /** Mean age of the open cards. 0 when the board is empty. */
    averageSeconds: number;
    lateCount: number;
    urgentCount: number;
};

const CLOSED_STATES = new Set(['served', 'cancelled']);

export function isOpenOrder(order: Pick<KitchenOrder, 'state'>): boolean {
    return !CLOSED_STATES.has(order.state);
}

/**
 * The summary bar (KDS-022).
 *
 * Averages only over *open* cards. Including the served ones would make the number fall as the
 * kitchen clears the board, which reads as "we are getting faster" at exactly the moment the line
 * is emptying — the opposite of useful.
 */
export function summarize(
    orders: readonly KitchenOrder[],
    now: number,
    thresholds: UrgencyThresholds,
): StationSummary {
    let openCount = 0;
    let oldest = 0;
    let total = 0;
    let late = 0;
    let urgent = 0;

    for (const order of orders) {
        if (!isOpenOrder(order)) continue;
        const seconds = elapsedSeconds(order, now);
        openCount += 1;
        total += seconds;
        if (seconds > oldest) oldest = seconds;
        const level = urgencyOf(seconds, thresholds);
        if (level === 'urgent') {
            urgent += 1;
            late += 1;
        } else if (level === 'late') {
            late += 1;
        }
    }

    return {
        openCount,
        oldestSeconds: oldest,
        averageSeconds: openCount === 0 ? 0 : Math.round(total / openCount),
        lateCount: late,
        urgentCount: urgent,
    };
}

/** How long a freshly arrived card keeps its "new" flash (KDS-014). */
export const NEW_FLASH_MS = 8_000;

export function isFlashingNew(firstSeenAt: number | undefined, now: number): boolean {
    return firstSeenAt !== undefined && now - firstSeenAt < NEW_FLASH_MS;
}
