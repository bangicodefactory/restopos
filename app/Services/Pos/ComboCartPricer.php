<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Models\Pos\PosConfig;
use App\Support\Money\Decimal;
use App\Support\Pricing\ComboPriceDistributor;
use App\Support\Pricing\Dto\ComboComponent;
use Illuminate\Database\ConnectionInterface;

/**
 * Server-side combo pricing for a submitted cart (SLF-030).
 *
 * The bug this exists to kill: `submitCart` priced every line through `PricingService::priceFor`,
 * which knows nothing about combos and returns each child's own list price. So a kiosk customer was
 * charged the combo price **plus** every component in full — the meal-deal discount silently
 * reversed between the screen they agreed to and the order they got.
 *
 * The arithmetic is not reimplemented here. It is
 * {@see ComboPriceDistributor}, the mirror of
 * `packages/domain/src/pricing/combo.ts`, driven by the same fixture corpus. What this class does
 * is assemble that distributor's inputs from the database rather than trusting the cart:
 *
 *  - the parent's price is its own list price (through the pricelist) plus the quota surcharge —
 *    the base price of every pick beyond a choice group's `qty_free`;
 *  - each child's weight is its choice group's `combos.base_price`, which is what "how much of the
 *    meal is this worth" means in this data model — never the child's own price;
 *  - `combo_items.extra_price` and the attribute extras are added *after* the split, so a paid
 *    upgrade never changes anyone else's share.
 */
final readonly class ComboCartPricer
{
    public function __construct(
        private ConnectionInterface $connection,
        private PricingService $pricing,
        private ComboPriceDistributor $distributor,
    ) {}

    /**
     * Unit prices for every line of the cart, keyed by the line's uuid.
     *
     * @param  list<array<string, mixed>>  $lines  raw cart lines, each with `uuid` and `variant_id`
     * @return array<string, string>
     */
    public function priceCart(PosConfig $config, ?int $pricelistId, array $lines, string $precision = '0.01'): array
    {
        $byUuid = [];

        foreach ($lines as $line) {
            $uuid = (string) ($line['uuid'] ?? '');
            if ($uuid !== '') {
                $byUuid[$uuid] = $line;
            }
        }

        $childrenByParent = [];

        foreach ($byUuid as $uuid => $line) {
            $parent = $line['combo_parent_uuid'] ?? null;
            if (is_string($parent) && $parent !== '' && isset($byUuid[$parent])) {
                $childrenByParent[$parent][] = $uuid;
            }
        }

        [$items, $groups] = $this->comboCatalogue($byUuid);
        $extras = $this->attributeExtras($byUuid);
        $prices = [];

        foreach ($byUuid as $uuid => $line) {
            $children = $childrenByParent[$uuid] ?? [];

            // A plain line, or a combo child (priced below by its parent) — the ordinary path.
            if ($children === []) {
                if (! isset($prices[$uuid])) {
                    $prices[$uuid] = $this->pricing->priceFor(
                        $config,
                        (int) $line['variant_id'],
                        $pricelistId,
                        (string) $line['quantity'],
                    );
                }

                continue;
            }

            $parentPrice = Decimal::of($this->pricing->priceFor(
                $config,
                (int) $line['variant_id'],
                $pricelistId,
                (string) $line['quantity'],
            ));

            // Quota surcharge: picks beyond a group's `qty_free` are charged that group's base
            // price. Without it a customer taking two drinks from a "pick 1" group pays for one.
            $perGroup = [];

            foreach ($children as $childUuid) {
                $item = $items[(int) ($byUuid[$childUuid]['combo_item_id'] ?? 0)] ?? null;
                if ($item !== null) {
                    $perGroup[$item['combo_id']][] = $childUuid;
                }
            }

            foreach ($perGroup as $comboId => $picks) {
                $group = $groups[$comboId] ?? null;
                $free = (int) ($group['qty_free'] ?? 1);

                for ($i = $free; $i < \count($picks); $i++) {
                    $parentPrice = $parentPrice->add(Decimal::of((string) ($group['base_price'] ?? '0')));
                }
            }

            $components = [];

            foreach ($children as $childUuid) {
                $child = $byUuid[$childUuid];
                $item = $items[(int) ($child['combo_item_id'] ?? 0)] ?? null;
                $group = $item === null ? null : ($groups[$item['combo_id']] ?? null);

                $components[] = new ComboComponent(
                    id: $childUuid,
                    comboBasePrice: (string) ($group['base_price'] ?? '0'),
                    quantity: '1',
                    extraPrice: (string) ($item['extra_price'] ?? '0'),
                    attributeExtra: $extras[$childUuid] ?? '0',
                );
            }

            // The parent carries none of the money. Its price is the *input* to the split, and every
            // cent of it comes back out on the children — a parent that also carried a price would
            // charge the meal twice. `combo.ts` prices its parent draft at '0' for the same reason.
            $prices[$uuid] = '0.0000';

            foreach ($this->distributor->distribute($parentPrice->toString(), $components, $precision) as $childUuid => $price) {
                $prices[$childUuid] = $price;
            }
        }

        return $prices;
    }

    /**
     * `combo_items` rows for every `combo_item_id` in the cart, and their owning choice groups.
     *
     * Returned as a pair rather than cached on the instance: the class is `readonly`, and a pricer
     * that remembered one cart's catalogue would be a stale-data bug waiting for the second call.
     *
     * @param  array<string, array<string, mixed>>  $byUuid
     * @return array{0: array<int, array{combo_id: int, extra_price: string}>, 1: array<int, array{base_price: string, qty_free: int}>}
     */
    private function comboCatalogue(array $byUuid): array
    {
        $ids = [];

        foreach ($byUuid as $line) {
            $id = (int) ($line['combo_item_id'] ?? 0);
            if ($id > 0) {
                $ids[$id] = true;
            }
        }

        if ($ids === []) {
            return [[], []];
        }

        $items = [];
        $comboIds = [];
        $groups = [];

        foreach ($this->connection->table('combo_items')->whereIn('id', array_keys($ids))->get() as $row) {
            $items[(int) $row->id] = [
                'combo_id' => (int) $row->combo_id,
                'extra_price' => (string) $row->extra_price,
            ];
            $comboIds[(int) $row->combo_id] = true;
        }

        foreach ($this->connection->table('combos')->whereIn('id', array_keys($comboIds))->get() as $row) {
            $groups[(int) $row->id] = [
                'base_price' => (string) $row->base_price,
                'qty_free' => (int) $row->qty_free,
            ];
        }

        return [$items, $groups];
    }

    /**
     * Attribute price extras per line, summed (SLF-027).
     *
     * @param  array<string, array<string, mixed>>  $byUuid
     * @return array<string, string>
     */
    private function attributeExtras(array $byUuid): array
    {
        $ids = [];

        foreach ($byUuid as $line) {
            foreach ((array) ($line['attribute_value_ids'] ?? []) as $id) {
                $ids[(int) $id] = true;
            }
        }

        if ($ids === []) {
            return [];
        }

        $priceById = $this->connection->table('product_attribute_line_values')
            ->whereIn('id', array_keys($ids))
            ->pluck('price_extra', 'id');

        $out = [];

        foreach ($byUuid as $uuid => $line) {
            $total = Decimal::of('0');

            foreach ((array) ($line['attribute_value_ids'] ?? []) as $id) {
                $total = $total->add(Decimal::of((string) ($priceById[(int) $id] ?? '0')));
            }

            $out[$uuid] = $total->toString();
        }

        return $out;
    }
}
