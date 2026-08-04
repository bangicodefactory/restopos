import { Decimal, ZERO } from '../money/decimal';
import { HALF_UP, parseRoundingMode, type RoundingMode } from '../money/rounding';
import type { CashRounding, Currency } from './types';

/**
 * §3.3 — currency rounding. A currency rounds to a *step* (0.01 / 0.05 / 0.001), not to a
 * number of decimal places; the decimal places only drive rendering (§3.3.4).
 */
export class CurrencyRounder {
    readonly step: Decimal;
    readonly mode: RoundingMode;

    constructor(readonly currency: Currency) {
        this.step = Decimal.of(currency.rounding);
        this.mode = parseRoundingMode(currency.roundingMode);
    }

    /** §3.3.3 */
    round(value: Decimal): Decimal {
        return value.roundToStep(this.step, this.mode);
    }

    /** §3.3.4 — render a money value at the currency's decimal places. */
    format(value: Decimal): string {
        return value.withScale(this.currency.decimalPlaces, HALF_UP).toString();
    }
}

export type CashRoundingResult = {
    readonly roundedTotal: Decimal;
    readonly delta: Decimal;
};

/**
 * §9 — cash rounding. `up` / `down` are away-from / toward **zero**, so a refund rounds as the
 * mirror of the sale.
 */
export class CashRoundingCalculator {
    constructor(private readonly config: CashRounding) {}

    apply(totalIncluded: Decimal): CashRoundingResult {
        const rounded = totalIncluded.roundToStep(
            Decimal.of(this.config.rounding),
            parseRoundingMode(this.config.method),
        );
        return { roundedTotal: rounded, delta: rounded.sub(totalIncluded) };
    }

    get strategy(): 'add_invoice_line' | 'biggest_tax' {
        return this.config.strategy ?? 'add_invoice_line';
    }
}

/**
 * §9.4 — the tolerance that makes a cash-rounded order settleable (REG-176).
 *
 * Cash rounding exists because the drawer has no coin smaller than the step. The consequence is
 * that the amount the cashier can physically take differs from the arithmetic total, so "is this
 * order paid?" cannot be `due <= 0`: under a nearest-step method the tender can legitimately fall
 * up to half a step short, and under a directional method (`up` / `down`) up to a full step.
 *
 *  - `half_up` — the total moved by at most ±step/2, so the tolerance is **step/2**.
 *  - anything else — the total moved by at most a full step, so the tolerance is **step**.
 *
 * With no cash rounding configured the tolerance is exactly zero, which collapses
 * {@link isFullyPaid} back to the strict `due <= 0` test. That is the point: a register without
 * cash rounding must not gain a slack band.
 */
export function fullyPaidTolerance(
    rounding: string | Decimal | null | undefined,
    method: RoundingMode = HALF_UP,
): Decimal {
    if (rounding === null || rounding === undefined) {
        return ZERO;
    }
    const step = Decimal.of(rounding).abs();
    if (step.isZero()) {
        return ZERO;
    }
    return method === HALF_UP ? step.div('2', step.scale + 1) : step;
}

/**
 * §9.4 — whether a remaining due of `due` closes the order (REG-176, REG-202).
 *
 * `due` is *remaining to collect*: positive means short, zero means exact, negative means the
 * customer overpaid and is owed change. Overpayment always settles, so the test is one-sided — the
 * tolerance only widens the band upward, by {@link fullyPaidTolerance}.
 *
 * Callers that must not grant the concession — a card tender, which can always be for the exact
 * amount — pass `null` for `rounding` and get the strict test back.
 */
export function isFullyPaid(
    due: string | Decimal,
    rounding: string | Decimal | null | undefined = null,
    method: RoundingMode = HALF_UP,
): boolean {
    return Decimal.of(due).lte(fullyPaidTolerance(rounding, method));
}
