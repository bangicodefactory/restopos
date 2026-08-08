import { Decimal, PRICE_SCALE, ZERO, MAX_SCALE } from '../money/decimal';
import { HALF_UP } from '../money/rounding';

/** §11.1 */
export type ComboComponentInput = {
    readonly id: string;
    readonly comboBasePrice: string;
    readonly quantity: string;
    readonly extraPrice?: string;
    readonly attributeExtra?: string;
};

export type ComboDistributionInput = {
    readonly parentPrice: string;
    /** rounding step for each share; defaults to the currency rounding. */
    readonly precision?: string;
    readonly components: readonly ComboComponentInput[];
};

export type ComboComponentPrice = {
    readonly id: string;
    readonly priceUnit: string;
};

/**
 * §11 — distribute a combo meal's price across its component lines.
 *
 * The residue always lands on the LAST component in stepper order (§11.2.5); this is the
 * classic one-cent-drift source and the reason `9.99` across two equal components splits
 * `5.00 / 4.99`.
 */
export class ComboPriceDistributor {
    distribute(input: ComboDistributionInput): ComboComponentPrice[] {
        const parentPrice = Decimal.of(input.parentPrice);
        const precision = Decimal.of(input.precision ?? '0.01');
        const components = input.components;
        const count = components.length;

        // Stryker disable next-line all: equivalent mutant — an early exit, not behaviour.
        // With no components `originalTotal` stays zero, both share loops run zero times and the
        // final map returns `[]` regardless, so no test can tell the guard from its absence. Kept
        // because it says what the function does with an empty meal; recorded here because the
        // alternative was a fixture that asserts something unfalsifiable (BAN-509).
        if (count === 0) {
            return [];
        }

        // §11.2.1
        let originalTotal = ZERO;
        for (const component of components) {
            originalTotal = originalTotal.add(
                Decimal.of(component.comboBasePrice).mul(Decimal.of(component.quantity)),
            );
        }

        const shares: Decimal[] = [];
        if (originalTotal.isZero()) {
            // §11.2.2
            for (let i = 0; i < count; i++) {
                shares.push(
                    i < count - 1
                        ? ZERO
                        : parentPrice.div(Decimal.of(components[i]!.quantity), PRICE_SCALE, HALF_UP),
                );
            }
        } else {
            // §11.2.3
            let remaining = parentPrice;
            for (let i = 0; i < count; i++) {
                const component = components[i]!;
                const quantity = Decimal.of(component.quantity);
                let share = Decimal.of(component.comboBasePrice)
                    .mul(parentPrice)
                    .div(originalTotal, MAX_SCALE, HALF_UP)
                    .roundToStep(precision, HALF_UP);
                remaining = remaining.sub(share.mul(quantity));
                if (i === count - 1) {
                    share = share.add(remaining.div(quantity, PRICE_SCALE, HALF_UP));
                    remaining = ZERO;
                }
                shares.push(share);
            }
        }

        // §11.2.4
        return components.map((component, i) => ({
            id: component.id,
            priceUnit: shares[i]!
                .add(Decimal.of(component.extraPrice ?? '0'))
                .add(Decimal.of(component.attributeExtra ?? '0'))
                .withScale(PRICE_SCALE, HALF_UP)
                .toString(),
        }));
    }
}

export const comboPriceDistributor = new ComboPriceDistributor();

export function distributeComboPrice(input: ComboDistributionInput): ComboComponentPrice[] {
    return comboPriceDistributor.distribute(input);
}
