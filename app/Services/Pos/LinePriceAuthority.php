<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\PriceType;
use App\Enums\SpecialKind;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Services\Identity\EmployeeAuthService;
use Illuminate\Database\ConnectionInterface;

/**
 * Who decides what a register line costs (XCT-107).
 *
 * The register resolved prices client-side and the server stored the number it was handed. The
 * `client_total_mismatch` warning was never a control on this: it compares the client's total
 * against the server's recomputation *of the client's own prices*, so a till that is internally
 * consistent — a bug, a stale pricelist, a crafted payload — agrees with itself and passes in
 * silence. A €10 pizza pushed at €0.01 was charged at €0.01 with no warning at all.
 *
 * The self-order path has had server authority since BAN-470 because the client there is a
 * stranger's phone. The register was left alone deliberately: on a till, a client-set price is
 * sometimes the *correct* answer, and taking that away would break real work. So this class does
 * not answer "is the client trusted" — it answers, line by line, **is there a server-side price
 * that is more authoritative than the one we were sent?**
 *
 * Five cases where the answer is no, each for its own reason:
 *
 *  - **open-price products** (a deposit, or anything whose catalogue price is zero) — the prompt
 *    *is* the price; there is nothing to overrule it with.
 *  - **special lines** — a tip, a global discount, a loyalty reward. Their amounts come from
 *    elsewhere in the system and a catalogue lookup would return nonsense.
 *  - **`automatic`** — already the output of a pricelist or reward calculation.
 *  - **`manual`** — a cashier's override, which is a real feature, gated below.
 *  - **a combo line the push cannot see whole** — pricing a meal from a fragment charges the
 *    components at list and reverses the meal deal, which is exactly the bug BAN-470 fixed for the
 *    kiosk. Better to leave a price alone than to confidently replace it with a wrong one.
 *
 * Everything else the server prices, and the client's number is ignored rather than warned about.
 */
final readonly class LinePriceAuthority
{
    public function __construct(
        private ConnectionInterface $connection,
        private PricingService $pricing,
        private ComboCartPricer $comboPricer,
        private EmployeeAuthService $employees,
    ) {}

    /**
     * Price every line this push touches, once, with the whole cart in view.
     *
     * Cart-level rather than per-line because a combo cannot be priced one row at a time — that is
     * the entire lesson of BAN-470 — and because the pricelist and the employee's abilities are
     * resolved once for the push rather than per line.
     *
     * @param  array<int, array<string, mixed>>  $lineCommands
     * @param  array<string, int>  $refundLinks  line uuid => the original line id it credits
     */
    public function plan(
        PosConfig $config,
        Order $order,
        array $lineCommands,
        ?int $employeeId = null,
        array $refundLinks = [],
    ): PricePlan {
        $commands = [];

        foreach ($lineCommands as $command) {
            $uuid = (string) ($command['uuid'] ?? '');

            if ($uuid !== '' && (string) ($command['op'] ?? 'create') !== 'delete') {
                $commands[$uuid] = (array) $command;
            }
        }

        if ($commands === []) {
            return new PricePlan([], [], [], []);
        }

        $held = $this->linesOnOrder($order);
        $cart = $this->cartView($commands, $held);
        $catalogue = $this->catalogue($cart);
        $mayOverride = $this->mayOverride($config, $employeeId);

        $prices = [];
        $extras = [];
        $refusals = [];
        // What the client asked for, kept only for lines the server ends up pricing itself. The
        // gap between the two is what the repricing actually changed, and the only bound on a
        // stale-price write-off that a device cannot inflate (BAN-514).
        $proposals = [];

        // Server prices for the whole cart, computed once. Includes lines this push does not touch,
        // because a combo's parent may already be on the order while only a child is being edited.
        $priced = $this->comboPricer->priceCart(
            $config,
            $this->pricing->resolvePricelistId($config, $order->pricelist_id, $order->pos_preset_id, $order->customer_id),
            array_values($cart),
            $this->roundingStep($config),
        );

        foreach ($commands as $uuid => $command) {
            $line = $cart[$uuid] ?? null;

            if ($line === null) {
                continue;
            }

            // Attribute extras are always the server's, whoever prices the line — they are a
            // catalogue fact, not a judgement, and a manual override says nothing about them. The
            // server already writes the real per-option amounts into `pos_order_line_attribute_value`
            // and then charged the client's figure beside them, so a line could carry
            // `price_extra: '-9.00'` against a pivot that said otherwise and take nine euros off in
            // silence — including on a line carrying no options at all, where the only honest
            // answer is zero.
            //
            // A combo child is the exception, and not an optional one: `ComboCartPricer` folds the
            // attribute extra into the price it distributes, so charging it again here would bill a
            // paid upgrade twice.
            $extras[$uuid] = $this->isComboChild($line, $cart)
                ? '0'
                : $this->attributeExtra(
                    (int) ($line['product_id'] ?? 0),
                    (array) ($command['attribute_line_value_ids'] ?? $line['attribute_value_ids'] ?? []),
                );

            // A refund is priced by what was actually charged, not by what the till says now. The
            // cap (BAN-406) bounds how *many* units come back; without this it says nothing about
            // the rate, so one unit of a 1-cent line could be credited at any price at all.
            if (isset($refundLinks[$uuid])) {
                $original = $this->originalPrice($refundLinks[$uuid]);

                if ($original !== null) {
                    $prices[$uuid] = $original;
                    $proposals[$uuid] = (string) ($command['price_unit'] ?? $line['price_unit'] ?? $original);
                }

                continue;
            }

            if ($this->verdict($config, $command, $line, $catalogue, $mayOverride) === PricePlan::Server) {
                if (isset($priced[$uuid])) {
                    $prices[$uuid] = $priced[$uuid];
                    // No `price_unit` in the command means an update that did not restate the
                    // price, so what the line already carries is the client's standing proposal.
                    $proposals[$uuid] = (string) ($command['price_unit'] ?? $line['price_unit'] ?? $priced[$uuid]);
                }

                // A manual price that the till was not entitled to set does not fail the sale — it
                // is corrected to the catalogue price and reported. Refusing the line would be
                // invisible: the client reads the *order's* status, so a refused line vanishes with
                // the cashier told nothing (the BAN-406 lesson). A corrected one is money-safe and
                // shows up in the response.
                if ($this->isManual($command, $line)) {
                    $refusals[] = [
                        'code' => 'price_override_refused',
                        'line_uuid' => $uuid,
                        'client' => (string) ($command['price_unit'] ?? ''),
                        'server' => $prices[$uuid] ?? null,
                    ];
                }
            }
        }

        return new PricePlan($prices, $extras, $refusals, $proposals);
    }

    /**
     * May this employee set a price by hand?
     *
     * Mirrors the till's own rule (`NumpadPanel`): with `restrict_price_control` off — the default —
     * price entry is an ordinary part of the job and nobody is asked for an ability. Turning the
     * setting on is what makes it a manager's action, and *then* the ability is required, checked
     * here rather than taken from the client.
     *
     * Deliberately not proof of identity. An employee id travels in the bootstrap payload, so a
     * crafted push can name a manager, and only a PIN would settle it — which the sync path cannot
     * ask for, because it must work hours after the fact and offline. What this does buy is that a
     * register left on a cashier's login cannot quietly reprice the catalogue, which is the thing
     * `restrict_price_control` exists to prevent.
     */
    private function mayOverride(PosConfig $config, ?int $employeeId): bool
    {
        if (! $config->restrict_price_control) {
            return true;
        }

        if ($employeeId === null) {
            return false;
        }

        $employee = $this->employees->candidates($config)->firstWhere('id', $employeeId);

        return $employee instanceof Employee
            && $this->employees->can($employee, $config, 'line.price_override');
    }

    /**
     * @param  array<string, mixed>  $command
     * @param  array<string, mixed>  $line
     * @param  array<int, array{special_kind: string, list_price: string}>  $catalogue
     */
    private function verdict(PosConfig $config, array $command, array $line, array $catalogue, bool $mayOverride): string
    {
        $product = $catalogue[(int) ($line['product_id'] ?? 0)] ?? null;

        // An open-price product: the prompt is the price, and the catalogue has nothing to say.
        // Same predicate the till uses to decide to prompt at all (`product-flow.ts`).
        if ($product !== null
            && ($product['special_kind'] === SpecialKind::Deposit->value
                || bccomp($product['list_price'], '0', 4) === 0)) {
            return PricePlan::Client;
        }

        // Tips, global discounts and loyalty rewards carry amounts computed elsewhere.
        if ($product !== null && $product['special_kind'] !== SpecialKind::None->value) {
            return PricePlan::Client;
        }

        $priceType = (string) ($command['price_type'] ?? $line['price_type'] ?? PriceType::Original->value);

        if ($priceType === PriceType::Automatic->value) {
            return PricePlan::Client;
        }

        if ($priceType === PriceType::Manual->value) {
            return $mayOverride ? PricePlan::Client : PricePlan::Server;
        }

        return PricePlan::Server;
    }

    /**
     * @param  array<string, mixed>  $command
     * @param  array<string, mixed>  $line
     */
    private function isManual(array $command, array $line): bool
    {
        return (string) ($command['price_type'] ?? $line['price_type'] ?? PriceType::Original->value)
            === PriceType::Manual->value;
    }

    /**
     * The cart as it will stand after this push: the commands, over the lines already on the order.
     *
     * Both halves matter. Without the commands a combo being rung up now is invisible; without the
     * held lines, editing one child of a combo already on the ticket would price that child as a
     * loose product — and a client could dodge combo pricing by pushing children on their own.
     *
     * @param  array<string, array<string, mixed>>  $commands
     * @param  array<string, array<string, mixed>>  $held
     * @return array<string, array<string, mixed>>
     */
    private function cartView(array $commands, array $held): array
    {
        $cart = $held;

        // One lookup for every product this push needs, rather than one per line. The register
        // re-pushes an order whole on each change, so anything per-line here is paid again on every
        // keystroke of a long tab.
        $productByVariant = $this->productIdsFor($commands, $held);

        foreach ($commands as $uuid => $command) {
            $existing = $held[$uuid] ?? [];

            $variantId = (int) ($command['variant_id'] ?? $command['product_variant_id'] ?? $existing['variant_id'] ?? 0);

            if ($variantId === 0) {
                continue;
            }

            $cart[$uuid] = [
                'uuid' => $uuid,
                'variant_id' => $variantId,
                'product_id' => (int) ($existing['product_id'] ?? $productByVariant[$variantId] ?? 0),
                'quantity' => (string) ($command['qty'] ?? $command['quantity'] ?? $existing['quantity'] ?? '1'),
                'combo_parent_uuid' => $command['combo_parent_uuid'] ?? $existing['combo_parent_uuid'] ?? null,
                'combo_item_id' => $command['combo_item_id'] ?? $existing['combo_item_id'] ?? null,
                // `ComboCartPricer` reads the self-order spelling; ingest uses the register's.
                'attribute_value_ids' => array_map(
                    'intval',
                    (array) ($command['attribute_line_value_ids'] ?? $existing['attribute_value_ids'] ?? []),
                ),
                'price_type' => $existing['price_type'] ?? PriceType::Original->value,
            ];
        }

        return $cart;
    }

    /**
     * The order's current lines, in the shape the pricer reads.
     *
     * @return array<string, array<string, mixed>>
     */
    private function linesOnOrder(Order $order): array
    {
        $rows = $this->connection->table('pos_order_lines as l')
            ->leftJoin('pos_order_lines as parent', 'parent.id', '=', 'l.combo_parent_line_id')
            ->where('l.pos_order_id', $order->getKey())
            ->whereNull('l.deleted_at')
            ->get([
                'l.uuid', 'l.product_variant_id', 'l.product_id', 'l.quantity', 'l.combo_item_id',
                'l.price_type', 'parent.uuid as parent_uuid',
            ]);

        $held = [];

        foreach ($rows as $row) {
            $held[(string) $row->uuid] = [
                'uuid' => (string) $row->uuid,
                'variant_id' => (int) $row->product_variant_id,
                'product_id' => (int) $row->product_id,
                'quantity' => (string) $row->quantity,
                'combo_parent_uuid' => $row->parent_uuid === null ? null : (string) $row->parent_uuid,
                'combo_item_id' => $row->combo_item_id === null ? null : (int) $row->combo_item_id,
                'price_type' => (string) $row->price_type,
                'attribute_value_ids' => [],
            ];
        }

        return $held;
    }

    /**
     * `special_kind` and `list_price` for every product in the cart — the two facts that decide
     * whether a price is the server's to set.
     *
     * @param  array<string, array<string, mixed>>  $cart
     * @return array<int, array{special_kind: string, list_price: string}>
     */
    private function catalogue(array $cart): array
    {
        $ids = array_values(array_unique(array_filter(array_map(
            static fn (array $line): int => (int) ($line['product_id'] ?? 0),
            $cart,
        ))));

        if ($ids === []) {
            return [];
        }

        $out = [];

        foreach ($this->connection->table('products')->whereIn('id', $ids)->get(['id', 'special_kind', 'list_price']) as $row) {
            $out[(int) $row->id] = [
                'special_kind' => (string) $row->special_kind,
                'list_price' => (string) $row->list_price,
            ];
        }

        return $out;
    }

    /**
     * The attribute extras for one line, from the catalogue and scoped to the line's own product —
     * the same validation `syncLineAttributes` applies when it writes the pivot, so the column and
     * the pivot cannot disagree.
     *
     * @param  list<int|string>  $valueIds
     */
    private function attributeExtra(int $productId, array $valueIds): string
    {
        $ids = array_values(array_unique(array_map('intval', $valueIds)));

        if ($ids === [] || $productId === 0) {
            return '0';
        }

        $total = '0';

        $prices = $this->connection->table('product_attribute_line_values')
            ->where('product_id', $productId)
            ->whereIn('id', $ids)
            ->pluck('price_extra', 'id');

        foreach ($ids as $id) {
            $total = bcadd($total, (string) ($prices[$id] ?? '0'), 4);
        }

        return $total;
    }

    /**
     * Is this line a component of a combo the pricer can see?
     *
     * Keyed on the parent being *in the cart*, not merely named: a child whose parent is absent was
     * not priced as part of a meal, so its extras are still its own.
     *
     * @param  array<string, mixed>  $line
     * @param  array<string, array<string, mixed>>  $cart
     */
    private function isComboChild(array $line, array $cart): bool
    {
        $parent = $line['combo_parent_uuid'] ?? null;

        return is_string($parent) && $parent !== '' && isset($cart[$parent]);
    }

    /** What the line being credited was actually charged. */
    private function originalPrice(int $originalLineId): ?string
    {
        $price = $this->connection->table('pos_order_lines')
            ->where('id', $originalLineId)
            ->value('price_unit');

        return $price === null ? null : (string) $price;
    }

    /**
     * `product_id` for every variant named by this push, in one query.
     *
     * Only for lines the order does not already hold — an existing line carries its own product id,
     * and asking again for it would be the per-line query this replaces.
     *
     * @param  array<string, array<string, mixed>>  $commands
     * @param  array<string, array<string, mixed>>  $held
     * @return array<int, int>
     */
    private function productIdsFor(array $commands, array $held): array
    {
        $variantIds = [];

        foreach ($commands as $uuid => $command) {
            if (isset($held[$uuid]['product_id'])) {
                continue;
            }

            $variantId = (int) ($command['variant_id'] ?? $command['product_variant_id'] ?? 0);

            if ($variantId > 0) {
                $variantIds[$variantId] = true;
            }
        }

        if ($variantIds === []) {
            return [];
        }

        return $this->connection->table('product_variants')
            ->whereIn('id', array_keys($variantIds))
            ->pluck('product_id', 'id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all();
    }

    private function roundingStep(PosConfig $config): string
    {
        if (! $config->use_cash_rounding || $config->cash_rounding_id === null) {
            return '0.01';
        }

        $rounding = $this->connection->table('cash_roundings')->where('id', $config->cash_rounding_id)->value('rounding');

        return $rounding === null ? '0.01' : (string) $rounding;
    }
}
