<?php

declare(strict_types=1);

namespace App\Support\Pricing;

use App\Support\Money\Decimal;
use App\Support\Money\RoundingMode;
use App\Support\Pricing\Dto\ComboComponent;

/**
 * §11 — distribute a combo meal's price across its component lines.
 *
 * The PHP half of the pair whose TypeScript half is
 * `packages/domain/src/pricing/combo.ts`. Both are driven by the same fixture corpus
 * (`tests/fixtures/tax/*.json`, the `combo` block) and asserted for exact string equality, exactly
 * as the tax engine is. Any change to one belongs in the other and in a fixture that would have
 * failed before — see docs/CONVENTIONS.md, "The tax-parity rule".
 *
 * Why this exists at all: without it the server had no combo arithmetic, so
 * `SelfOrderService::submitCart` priced each child at its own list price and silently reversed the
 * combo discount. A kiosk customer was charged the combo price *plus* every child in full.
 *
 * The residue always lands on the LAST component in stepper order (§11.2.5). That is the classic
 * one-cent-drift source, and the reason `9.99` across two equal components splits `5.00 / 4.99`
 * rather than throwing half a cent away.
 */
final class ComboPriceDistributor
{
    /**
     * @param  list<ComboComponent>  $components
     * @return array<string, string> component id => unit price, at PRICE_SCALE
     */
    public function distribute(string $parentPrice, array $components, string $precision = '0.01'): array
    {
        $count = \count($components);

        if ($count === 0) {
            return [];
        }

        $parent = Decimal::of($parentPrice);
        $step = Decimal::of($precision);

        // §11.2.1 — the weights are the *combo base prices*, not the components' own prices.
        $originalTotal = Decimal::of('0');

        foreach ($components as $component) {
            $originalTotal = $originalTotal->add(
                Decimal::of($component->comboBasePrice)->mul(Decimal::of($component->quantity)),
            );
        }

        /** @var list<Decimal> $shares */
        $shares = [];

        if ($originalTotal->isZero()) {
            // §11.2.2 — nothing to weight by: the whole price rides on the last component rather
            // than being spread evenly, so the parent price is preserved exactly.
            foreach ($components as $i => $component) {
                $shares[] = $i < $count - 1
                    ? Decimal::of('0')
                    : $parent->div(Decimal::of($component->quantity), Decimal::PRICE_SCALE, RoundingMode::HalfUp);
            }
        } else {
            // §11.2.3
            $remaining = $parent;

            foreach ($components as $i => $component) {
                $quantity = Decimal::of($component->quantity);

                $share = Decimal::of($component->comboBasePrice)
                    ->mul($parent)
                    ->div($originalTotal, Decimal::MAX_SCALE, RoundingMode::HalfUp)
                    ->roundToStep($step, RoundingMode::HalfUp);

                $remaining = $remaining->sub($share->mul($quantity));

                if ($i === $count - 1) {
                    $share = $share->add($remaining->div($quantity, Decimal::PRICE_SCALE, RoundingMode::HalfUp));
                    $remaining = Decimal::of('0');
                }

                $shares[] = $share;
            }
        }

        // §11.2.4 — the extras are added *after* the split, so they never influence it.
        $out = [];

        foreach ($components as $i => $component) {
            $out[$component->id] = $shares[$i]
                ->add(Decimal::of($component->extraPrice))
                ->add(Decimal::of($component->attributeExtra))
                ->withScale(Decimal::PRICE_SCALE, RoundingMode::HalfUp)
                ->toString();
        }

        return $out;
    }
}
