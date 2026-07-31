import { Decimal } from '../money/decimal';
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
