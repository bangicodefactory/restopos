<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\CashCountType;
use App\Enums\CashMovementType;
use App\Enums\OrderPrepState;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Enums\PaymentStatus;
use App\Enums\PrepChangeType;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PriceType;
use App\Enums\SessionState;
use App\Support\Money\Decimal;
use App\Support\Tax\Dto\Currency;
use App\Support\Tax\Dto\FiscalPosition;
use App\Support\Tax\Dto\FiscalPositionMapping;
use App\Support\Tax\Dto\LineInput;
use App\Support\Tax\Dto\OrderInput;
use App\Support\Tax\Dto\TaxDefinition;
use App\Support\Tax\TaxEngine;
use Database\Seeders\Support\Demo;
use DateTimeImmutable;
use Illuminate\Database\Seeder;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Thirty days of trading: ~120 orders spread over closed sessions, plus a live
 * session with draft orders sitting on tables so the register opens on
 * something.
 *
 * Every amount in here comes out of {@see TaxEngine} — the same engine the
 * application uses at runtime — so the demo database satisfies the same
 * invariants the app enforces: an order's total is the sum of its lines, a
 * session's totals are the sum of its orders, and the tax summary reconciles
 * with the per-line breakdown.
 *
 * Query builder only for the order tables: `App\Models\Pos\Order` and friends do
 * not exist yet.
 */
class DemoOrderSeeder extends Seeder
{
    private const ORDER_TARGET = 120;

    private const DAYS = 30;

    private const REFUND_TARGET = 3;

    private const OPENING_FLOAT = '200.0000';

    private int $companyId;

    private int $currencyId;

    private string $now;

    private TaxEngine $engine;

    private Currency $currency;

    /** @var array<int, TaxDefinition> */
    private array $taxCatalog = [];

    /** @var array<int, FiscalPosition> */
    private array $fiscalPositions = [];

    /** @var list<array<string, mixed>> */
    private array $sellable = [];

    /** @var list<array<string, mixed>> */
    private array $comboProducts = [];

    /** @var array<int, list<array{id: int, name: string, extra: string}>> product id => no-variant attribute values */
    private array $noVariantValues = [];

    /** @var array<int, list<array{comboId: int, itemId: int, variantId: int, productId: int, categoryId: ?int, name: string, extra: string, taxIds: list<int>, uomId: int, cost: string}>> */
    private array $comboChoices = [];

    /** @var array<string, int> */
    private array $paymentMethods = [];

    /** @var array<string, int> */
    private array $presets = [];

    /** @var array<int, ?int> preset id => fiscal position id */
    private array $presetFiscalPosition = [];

    /** @var list<object> */
    private array $employees = [];

    /** @var list<int> */
    private array $customerIds = [];

    /** @var array<string, object> */
    private array $configs = [];

    /** @var array<int, list<int>> config id => restaurant table ids */
    private array $tablesByConfig = [];

    /** @var array<int, array{value: string, cents: int, id: int}> */
    private array $denominations = [];

    /** @var array<string, int> */
    private array $sequenceCounters = [];

    /** @var list<array{orderId: int, lines: list<array<string, mixed>>, sessionId: int, configId: int, total: string}> */
    private array $refundable = [];

    /** @var array<int, list<array{id: int, categories: list<int>, stages: list<int>}>> */
    private array $prepDisplays = [];

    private int $orderCounter = 0;

    private int $refundsCreated = 0;

    public function run(): void
    {
        $rng = Demo::reseed('orders');

        $companyId = DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === null) {
            return;
        }
        $this->companyId = (int) $companyId;

        if (DB::table('pos_orders')->where('company_id', $this->companyId)->exists()) {
            return;
        }

        $this->currencyId = (int) DB::table('currencies')->where('code', 'EUR')->value('id');
        $this->now = Demo::ts(Demo::clock());
        $this->engine = new TaxEngine;
        $this->currency = new Currency('EUR', 2, '0.01');

        $this->loadContext();
        if ($this->sellable === [] || $this->configs === []) {
            return;
        }

        DB::transaction(function () use ($rng): void {
            $plan = $this->planSessions($rng);
            $remainingSessions = count($plan);
            $remainingOrders = self::ORDER_TARGET;

            foreach ($plan as $index => $slot) {
                $isLast = $index === count($plan) - 1;
                $orderCount = $isLast
                    ? max(1, $remainingOrders)
                    : min($remainingOrders - ($remainingSessions - 1), max(1, (int) round($remainingOrders / $remainingSessions)));
                // The live session always gets 5: three paid, two still on a table.
                $orderCount = $slot['open'] ? 5 : max(1, min($orderCount, 8));

                $this->seedSession($slot['daysAgo'], $slot['config'], $orderCount, $slot['open'], $rng);

                $remainingOrders -= $orderCount;
                $remainingSessions--;
            }

            $this->seedInvoices();
            $this->seedEditLogs($rng);
            $this->bumpSequences();
            $this->refreshCustomerStats();
        });
    }

    // ------------------------------------------------------------------ context

    private function loadContext(): void
    {
        foreach (DB::table('taxes')->where('company_id', $this->companyId)->get() as $tax) {
            $children = DB::table('tax_children')
                ->where('parent_tax_id', $tax->id)
                ->orderBy('sequence')
                ->pluck('child_tax_id')
                ->map(static fn ($value): int => (int) $value)
                ->all();

            $this->taxCatalog[(int) $tax->id] = new TaxDefinition(
                id: (int) $tax->id,
                amountType: (string) $tax->amount_type,
                amount: (string) $tax->amount,
                sequence: (int) $tax->sequence,
                taxGroupId: (int) $tax->tax_group_id,
                name: (string) $tax->name,
                priceInclude: (bool) $tax->price_include,
                includeBaseAmount: (bool) $tax->include_base_amount,
                isBaseAffected: (bool) $tax->is_base_affected,
                hasNegativeFactor: (bool) $tax->has_negative_factor,
                childrenTaxIds: $children,
            );
        }

        foreach (DB::table('fiscal_positions')->where('company_id', $this->companyId)->get() as $position) {
            $mappings = [];
            foreach (DB::table('fiscal_position_taxes')->where('fiscal_position_id', $position->id)->get() as $mapping) {
                $mappings[] = new FiscalPositionMapping(
                    (int) $mapping->tax_src_id,
                    $mapping->tax_dest_id === null ? null : (int) $mapping->tax_dest_id,
                );
            }
            $this->fiscalPositions[(int) $position->id] = new FiscalPosition($mappings, (int) $position->id, (string) $position->name);
        }

        $categoryByProduct = DB::table('pos_category_product')
            ->orderBy('sequence')->get()->keyBy('product_id');

        $productTaxes = [];
        foreach (DB::table('product_tax')->get() as $row) {
            $productTaxes[(int) $row->product_id][] = (int) $row->tax_id;
        }
        $variantTaxes = [];
        foreach (DB::table('product_variant_tax')->get() as $row) {
            $variantTaxes[(int) $row->product_variant_id][] = (int) $row->tax_id;
        }

        $rows = DB::table('product_variants as v')
            ->join('products as p', 'p.id', '=', 'v.product_id')
            ->where('v.company_id', $this->companyId)
            ->where('v.active', true)
            ->where('p.active', true)
            ->select([
                'v.id as variant_id', 'v.display_name', 'v.price_extra', 'v.standard_price as variant_cost',
                'p.id as product_id', 'p.name as product_name', 'p.list_price', 'p.uom_id',
                'p.product_type', 'p.to_weight', 'p.is_special', 'p.available_in_pos',
            ])
            ->orderBy('v.id')
            ->get();

        foreach ($rows as $row) {
            $entry = [
                'variantId' => (int) $row->variant_id,
                'productId' => (int) $row->product_id,
                'name' => (string) $row->display_name,
                'productName' => (string) $row->product_name,
                'basePrice' => (string) $row->list_price,
                'priceExtra' => (string) $row->price_extra,
                'cost' => (string) $row->variant_cost,
                'uomId' => (int) $row->uom_id,
                'toWeigh' => (bool) $row->to_weight,
                'categoryId' => isset($categoryByProduct[$row->product_id])
                    ? (int) $categoryByProduct[$row->product_id]->pos_category_id
                    : null,
                'taxIds' => $variantTaxes[(int) $row->variant_id] ?? ($productTaxes[(int) $row->product_id] ?? []),
                'type' => (string) $row->product_type,
            ];

            if ((bool) $row->is_special || ! (bool) $row->available_in_pos) {
                continue;
            }

            if ($entry['type'] === 'combo') {
                $this->comboProducts[] = $entry;

                continue;
            }

            // Open-price articles have no catalog price; they are used explicitly.
            if (Decimal::of($entry['basePrice'])->isZero()) {
                continue;
            }

            $this->sellable[] = $entry;
        }

        $this->loadNoVariantValues();
        $this->loadComboChoices($categoryByProduct, $productTaxes, $variantTaxes);

        $this->paymentMethods = DB::table('payment_methods')
            ->where('company_id', $this->companyId)
            ->pluck('id', 'name')->map(static fn ($value): int => (int) $value)->all();

        foreach (DB::table('pos_presets')->where('company_id', $this->companyId)->get() as $preset) {
            $this->presets[(string) $preset->name] = (int) $preset->id;
            $this->presetFiscalPosition[(int) $preset->id] = $preset->fiscal_position_id === null
                ? null
                : (int) $preset->fiscal_position_id;
        }

        $this->employees = DB::table('employees')
            ->where('company_id', $this->companyId)
            ->where('default_role', '!=', 'minimal')
            ->orderBy('id')->get()->all();

        $this->customerIds = DB::table('customers')
            ->where('company_id', $this->companyId)
            ->where('name', '!=', 'Client comptoir')
            ->orderBy('id')->pluck('id')->map(static fn ($value): int => (int) $value)->all();

        foreach (DB::table('pos_configs')->where('company_id', $this->companyId)->get() as $config) {
            $this->configs[(string) $config->name] = $config;

            $floorIds = DB::table('pos_config_floor')
                ->where('pos_config_id', $config->id)->pluck('restaurant_floor_id');

            $this->tablesByConfig[(int) $config->id] = $floorIds->isEmpty()
                ? []
                : DB::table('restaurant_tables')
                    ->whereIn('restaurant_floor_id', $floorIds)
                    ->orderBy('table_number')
                    ->pluck('id')->map(static fn ($value): int => (int) $value)->all();

            $displays = [];
            foreach (DB::table('pos_config_prep_display')->where('pos_config_id', $config->id)->pluck('prep_display_id') as $displayId) {
                $displays[] = [
                    'id' => (int) $displayId,
                    'categories' => DB::table('pos_category_prep_display')
                        ->where('prep_display_id', $displayId)
                        ->pluck('pos_category_id')->map(static fn ($value): int => (int) $value)->all(),
                    'stages' => DB::table('prep_stages')
                        ->where('prep_display_id', $displayId)
                        ->orderBy('sequence')
                        ->pluck('id')->map(static fn ($value): int => (int) $value)->all(),
                ];
            }
            $this->prepDisplays[(int) $config->id] = $displays;
        }

        foreach (DB::table('pos_bills')->where('company_id', $this->companyId)->orderByDesc('value')->get() as $bill) {
            $this->denominations[] = [
                'value' => (string) $bill->value,
                'cents' => (int) round((float) $bill->value * 100),
                'id' => (int) $bill->id,
            ];
        }
    }

    private function loadNoVariantValues(): void
    {
        $rows = DB::table('product_attribute_line_values as plv')
            ->join('product_attribute_lines as pl', 'pl.id', '=', 'plv.product_attribute_line_id')
            ->join('product_attributes as pa', 'pa.id', '=', 'pl.product_attribute_id')
            ->join('product_attribute_values as pv', 'pv.id', '=', 'plv.product_attribute_value_id')
            ->where('pa.create_variant', 'no_variant')
            ->select(['plv.id', 'plv.product_id', 'plv.price_extra', 'pv.name'])
            ->orderBy('plv.id')
            ->get();

        foreach ($rows as $row) {
            $this->noVariantValues[(int) $row->product_id][] = [
                'id' => (int) $row->id,
                'name' => (string) $row->name,
                'extra' => (string) $row->price_extra,
            ];
        }
    }

    /**
     * @param  Collection<int|string, object>  $categoryByProduct
     * @param  array<int, list<int>>  $productTaxes
     * @param  array<int, list<int>>  $variantTaxes
     */
    private function loadComboChoices($categoryByProduct, array $productTaxes, array $variantTaxes): void
    {
        foreach ($this->comboProducts as $combo) {
            $comboIds = DB::table('combo_product')
                ->where('product_id', $combo['productId'])
                ->orderBy('sequence')->pluck('combo_id');

            $choices = [];
            foreach ($comboIds as $comboId) {
                $item = DB::table('combo_items as ci')
                    ->join('product_variants as v', 'v.id', '=', 'ci.product_variant_id')
                    ->join('products as p', 'p.id', '=', 'v.product_id')
                    ->where('ci.combo_id', $comboId)
                    ->orderBy('ci.sequence')
                    ->select([
                        'ci.id as item_id', 'ci.extra_price', 'v.id as variant_id', 'v.display_name',
                        'p.id as product_id', 'p.uom_id', 'v.standard_price',
                    ])
                    ->first();

                if ($item === null) {
                    continue;
                }

                $choices[] = [
                    'comboId' => (int) $comboId,
                    'itemId' => (int) $item->item_id,
                    'variantId' => (int) $item->variant_id,
                    'productId' => (int) $item->product_id,
                    'categoryId' => isset($categoryByProduct[$item->product_id])
                        ? (int) $categoryByProduct[$item->product_id]->pos_category_id
                        : null,
                    'name' => (string) $item->display_name,
                    'extra' => (string) $item->extra_price,
                    'taxIds' => $variantTaxes[(int) $item->variant_id] ?? ($productTaxes[(int) $item->product_id] ?? []),
                    'uomId' => (int) $item->uom_id,
                    'cost' => (string) $item->standard_price,
                ];
            }

            $this->comboChoices[$combo['productId']] = $choices;
        }
    }

    // -------------------------------------------------------------------- plan

    /** @return list<array{daysAgo: int, config: object, open: bool}> */
    private function planSessions(Demo $rng): array
    {
        $room = $this->configs[PosConfigSeeder::CONFIG_ROOM];
        $counter = $this->configs[PosConfigSeeder::CONFIG_COUNTER] ?? $room;
        $bar = $this->configs[PosConfigSeeder::CONFIG_BAR] ?? $room;

        $plan = [];
        for ($daysAgo = self::DAYS - 1; $daysAgo >= 1; $daysAgo--) {
            $plan[] = ['daysAgo' => $daysAgo, 'config' => $room, 'open' => false];

            if ($daysAgo % 4 === 0) {
                $plan[] = ['daysAgo' => $daysAgo, 'config' => $counter, 'open' => false];
            }
            if ($daysAgo % 7 === 0) {
                $plan[] = ['daysAgo' => $daysAgo, 'config' => $bar, 'open' => false];
            }
        }

        // Yesterday's counter session is deliberately left in closing control so
        // the back-office has a session to chase.
        $plan[] = ['daysAgo' => 0, 'config' => $room, 'open' => true];

        unset($rng);

        return $plan;
    }

    // ----------------------------------------------------------------- sessions

    private function seedSession(int $daysAgo, object $config, int $orderCount, bool $keepOpen, Demo $rng): void
    {
        $configId = (int) $config->id;
        $configName = (string) $config->name;
        $opener = $this->employees[$rng->int(0, count($this->employees) - 1)];

        $openedAt = Demo::at($daysAgo, 11, 30);
        $closedAt = Demo::at($daysAgo, 23, 45);

        $sessionName = $this->nextSequence('session:'.$configId, $this->sessionPrefix($configName), 4);

        $sessionId = (int) DB::table('pos_sessions')->insertGetId([
            'uuid' => Demo::uuid('session:'.$configId.':'.$daysAgo),
            'pos_config_id' => $configId,
            'company_id' => $this->companyId,
            'currency_id' => $this->currencyId,
            'name' => $sessionName,
            'state' => $keepOpen ? SessionState::Opened->value : SessionState::Closed->value,
            'opened_by_employee_id' => $opener->id,
            'closed_by_employee_id' => $keepOpen ? null : $opener->id,
            'opened_at' => Demo::ts($openedAt),
            'closed_at' => $keepOpen ? null : Demo::ts($closedAt),
            'business_date' => Demo::day($daysAgo)->format('Y-m-d'),
            'opening_notes' => $daysAgo % 6 === 0 ? 'Fond de caisse vérifié à l’ouverture.' : null,
            'closing_notes' => $keepOpen ? null : ($daysAgo % 9 === 0 ? 'Écart de caisse justifié par un rendu monnaie.' : null),
            'has_cash_control' => (bool) $config->has_cash_control,
            'cash_balance_opening' => self::OPENING_FLOAT,
            'cash_balance_opening_expected' => self::OPENING_FLOAT,
            'is_rescue' => false,
            'closing_forced' => false,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        $this->seedCashCount($sessionId, CashCountType::Opening, self::OPENING_FLOAT, $opener, Demo::at($daysAgo, 11, 25));

        $cashIn = Decimal::zero();
        $cashOut = Decimal::zero();
        if (! $keepOpen && $rng->chance(35)) {
            $amount = (string) $rng->int(15, 60).'.0000';
            $cashOut = $cashOut->add($amount);
            DB::table('cash_movements')->insert([
                'uuid' => Demo::uuid('cash-out:'.$sessionId),
                'pos_session_id' => $sessionId,
                'company_id' => $this->companyId,
                'movement_type' => CashMovementType::CashOut->value,
                'amount' => '-'.$amount,
                'reason' => $rng->pick(['Achat de pain', 'Livraison marché', 'Fleurs pour la salle', 'Taxi coursier']),
                'employee_id' => $opener->id,
                'moved_at' => Demo::ms(Demo::at($daysAgo, 16, 10)),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }
        if (! $keepOpen && $rng->chance(15)) {
            $amount = (string) $rng->int(50, 150).'.0000';
            $cashIn = $cashIn->add($amount);
            DB::table('cash_movements')->insert([
                'uuid' => Demo::uuid('cash-in:'.$sessionId),
                'pos_session_id' => $sessionId,
                'company_id' => $this->companyId,
                'movement_type' => CashMovementType::CashIn->value,
                'amount' => $amount,
                'reason' => 'Appoint de monnaie',
                'employee_id' => $opener->id,
                'moved_at' => Demo::ms(Demo::at($daysAgo, 18, 40)),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        // --- orders -------------------------------------------------------
        $orderTotals = Decimal::zero();
        $refundTotals = Decimal::zero();
        $paymentsTotal = Decimal::zero();
        $cashNet = Decimal::zero();
        $paidOrders = 0;

        /** @var array<int, array{expected: Decimal, count: int, refund: Decimal, change: Decimal}> $byMethod */
        $byMethod = [];
        /** @var array<string, array{categoryId: ?int, productId: int, signature: string, refund: bool, qty: Decimal, base: Decimal, discount: Decimal, tax: Decimal, total: Decimal, cost: Decimal}> $salesSummary */
        $salesSummary = [];
        /** @var array<string, array{taxId: int, groupId: int, refund: bool, base: Decimal, amount: Decimal, rate: string}> $taxSummary */
        $taxSummary = [];

        for ($index = 0; $index < $orderCount; $index++) {
            $isDraft = $keepOpen && $index >= $orderCount - 2;
            $hour = 12 + (int) floor($index * (10 / max(1, $orderCount)));
            $orderedAt = Demo::at($daysAgo, min(23, $hour), $rng->int(0, 59), $rng->int(0, 59));

            $order = $this->buildOrder($config, $sessionId, $orderedAt, $isDraft, false, null, $rng);
            if ($order === null) {
                continue;
            }

            if ($isDraft) {
                continue;
            }

            $paidOrders++;
            $orderTotals = $orderTotals->add($order['total']);
            $paymentsTotal = $paymentsTotal->add($order['paid']);
            $cashNet = $cashNet->add($order['cashNet']);
            $this->accumulate($order, $byMethod, $salesSummary, $taxSummary);
        }

        // --- refunds ------------------------------------------------------
        if (! $keepOpen && $this->refundable !== [] && $this->refundsCreated < self::REFUND_TARGET
            && in_array($daysAgo, [4, 11, 19], true)) {
            $this->refundsCreated++;
            $source = array_pop($this->refundable);
            $refund = $this->buildOrder(
                $config,
                $sessionId,
                Demo::at($daysAgo, 21, 5),
                false,
                true,
                $source,
                $rng,
            );

            if ($refund !== null) {
                $paidOrders++;
                $refundTotals = $refundTotals->add(Decimal::of($refund['total'])->abs());
                $paymentsTotal = $paymentsTotal->add($refund['paid']);
                $cashNet = $cashNet->add($refund['cashNet']);
                $this->accumulate($refund, $byMethod, $salesSummary, $taxSummary);
            }
        }

        // --- closing ------------------------------------------------------
        $expectedCash = Decimal::of(self::OPENING_FLOAT)->add($cashNet)->add($cashIn)->sub($cashOut);
        $difference = Decimal::zero();
        if (! $keepOpen && $rng->chance(20)) {
            $difference = Decimal::of($rng->chance(50) ? '0.05' : '-0.10');
        }
        $countedCash = $expectedCash->add($difference);

        foreach ($byMethod as $methodId => $totals) {
            DB::table('session_payment_totals')->insert([
                'pos_session_id' => $sessionId,
                'payment_method_id' => $methodId,
                'currency_id' => $this->currencyId,
                'expected_amount' => $this->money($totals['expected']),
                'counted_amount' => $keepOpen ? null : $this->money(
                    $methodId === $this->paymentMethods[PosConfigSeeder::PM_CASH]
                        ? $totals['expected']->add($difference)
                        : $totals['expected'],
                ),
                'difference_amount' => $keepOpen
                    ? '0.0000'
                    : $this->money($methodId === $this->paymentMethods[PosConfigSeeder::PM_CASH] ? $difference : Decimal::zero()),
                'payment_count' => $totals['count'],
                'refund_amount' => $this->money($totals['refund']),
                'change_amount' => $this->money($totals['change']),
                'ledger_code' => DB::table('payment_methods')->where('id', $methodId)->value('ledger_code'),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        if (! $keepOpen) {
            $this->seedCashCount($sessionId, CashCountType::Closing, $this->money($countedCash), $opener, $closedAt);

            foreach ($salesSummary as $summary) {
                DB::table('session_sales_summaries')->insert([
                    'pos_session_id' => $sessionId,
                    'pos_category_id' => $summary['categoryId'],
                    'product_id' => $summary['productId'],
                    'tax_signature' => $summary['signature'],
                    'is_refund' => $summary['refund'],
                    'quantity' => $summary['qty']->withScale(3)->toString(),
                    'base_amount' => $this->money($summary['base']),
                    'discount_amount' => $this->money($summary['discount']),
                    'tax_amount' => $this->money($summary['tax']),
                    'total_amount' => $this->money($summary['total']),
                    'cost_amount' => $this->money($summary['cost']),
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }

            foreach ($taxSummary as $summary) {
                DB::table('session_tax_summaries')->insert([
                    'pos_session_id' => $sessionId,
                    'tax_id' => $summary['taxId'],
                    'tax_group_id' => $summary['groupId'],
                    'is_refund' => $summary['refund'],
                    'base_amount' => $this->money($summary['base']),
                    'tax_amount' => $this->money($summary['amount']),
                    'tax_rate' => $summary['rate'],
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }
        }

        DB::table('pos_sessions')->where('id', $sessionId)->update([
            'cash_balance_closing_counted' => $keepOpen ? null : $this->money($countedCash),
            'cash_balance_closing_expected' => $this->money($expectedCash),
            'cash_difference' => $this->money($difference),
            'cash_in_total' => $this->money($cashIn),
            'cash_out_total' => $this->money($cashOut),
            'order_count' => $paidOrders,
            'order_amount_total' => $this->money($orderTotals),
            'refund_amount_total' => $this->money($refundTotals),
            'payments_total' => $this->money($paymentsTotal),
            'updated_at' => $this->now,
        ]);
    }

    /**
     * @param  array<int, array{expected: Decimal, count: int, refund: Decimal, change: Decimal}>  $byMethod
     * @param  array<string, array{categoryId: ?int, productId: int, signature: string, refund: bool, qty: Decimal, base: Decimal, discount: Decimal, tax: Decimal, total: Decimal, cost: Decimal}>  $salesSummary
     * @param  array<string, array{taxId: int, groupId: int, refund: bool, base: Decimal, amount: Decimal, rate: string}>  $taxSummary
     * @param  array<string, mixed>  $order
     */
    private function accumulate(array $order, array &$byMethod, array &$salesSummary, array &$taxSummary): void
    {
        foreach ($order['payments'] as $payment) {
            $methodId = $payment['methodId'];
            $byMethod[$methodId] ??= [
                'expected' => Decimal::zero(), 'count' => 0,
                'refund' => Decimal::zero(), 'change' => Decimal::zero(),
            ];
            $byMethod[$methodId]['expected'] = $byMethod[$methodId]['expected']->add($payment['amount']);
            if (! $payment['isChange']) {
                $byMethod[$methodId]['count']++;
            }
            if ($payment['isRefund']) {
                $byMethod[$methodId]['refund'] = $byMethod[$methodId]['refund']->add(Decimal::of($payment['amount'])->abs());
            }
            if ($payment['isChange']) {
                $byMethod[$methodId]['change'] = $byMethod[$methodId]['change']->add(Decimal::of($payment['amount'])->abs());
            }
        }

        $isRefund = (bool) $order['isRefund'];

        foreach ($order['lines'] as $line) {
            $key = ($line['categoryId'] ?? 0).':'.$line['productId'].':'.$line['signature'].':'.($isRefund ? '1' : '0');
            $salesSummary[$key] ??= [
                'categoryId' => $line['categoryId'],
                'productId' => $line['productId'],
                'signature' => $line['signature'],
                'refund' => $isRefund,
                'qty' => Decimal::zero(),
                'base' => Decimal::zero(),
                'discount' => Decimal::zero(),
                'tax' => Decimal::zero(),
                'total' => Decimal::zero(),
                'cost' => Decimal::zero(),
            ];
            $salesSummary[$key]['qty'] = $salesSummary[$key]['qty']->add($line['quantity']);
            $salesSummary[$key]['base'] = $salesSummary[$key]['base']->add($line['subtotal']);
            $salesSummary[$key]['discount'] = $salesSummary[$key]['discount']->add($line['discountAmount']);
            $salesSummary[$key]['tax'] = $salesSummary[$key]['tax']
                ->add(Decimal::of($line['subtotalIncl'])->sub($line['subtotal']));
            $salesSummary[$key]['total'] = $salesSummary[$key]['total']->add($line['subtotalIncl']);
            $salesSummary[$key]['cost'] = $salesSummary[$key]['cost']->add($line['totalCost']);

            foreach ($line['taxDetails'] as $detail) {
                $taxId = (int) $detail['taxId'];
                $tax = $this->taxCatalog[$taxId];
                $key = $taxId.':'.($isRefund ? '1' : '0');
                $taxSummary[$key] ??= [
                    'taxId' => $taxId,
                    'groupId' => $tax->taxGroupId,
                    'refund' => $isRefund,
                    'base' => Decimal::zero(),
                    'amount' => Decimal::zero(),
                    'rate' => $tax->amount,
                ];
                $taxSummary[$key]['base'] = $taxSummary[$key]['base']->add($detail['base']);
                $taxSummary[$key]['amount'] = $taxSummary[$key]['amount']->add($detail['amount']);
            }
        }
    }

    // ------------------------------------------------------------------- orders

    /**
     * @param  array{orderId: int, lines: list<array<string, mixed>>, sessionId: int, configId: int, total: string}|null  $refundOf
     * @return array<string, mixed>|null
     */
    private function buildOrder(
        object $config,
        int $sessionId,
        DateTimeImmutable $orderedAt,
        bool $isDraft,
        bool $isRefund,
        ?array $refundOf,
        Demo $rng,
    ): ?array {
        $configId = (int) $config->id;
        $configName = (string) $config->name;
        $isRestaurant = (bool) $config->is_restaurant;

        // A live order must sit on a table, otherwise the register opens on an
        // empty floor plan and the restaurant flow has nothing to show.
        $presetName = match (true) {
            $isDraft && $isRestaurant => PosConfigSeeder::PRESET_DINE_IN,
            $isRestaurant => $rng->chance(80) ? PosConfigSeeder::PRESET_DINE_IN : PosConfigSeeder::PRESET_TAKEAWAY,
            default => $rng->chance(75) ? PosConfigSeeder::PRESET_TAKEAWAY : PosConfigSeeder::PRESET_DELIVERY,
        };
        $presetId = $this->presets[$presetName] ?? null;
        $fiscalPositionId = $presetId === null ? null : $this->presetFiscalPosition[$presetId];
        $fiscalPosition = $fiscalPositionId === null ? null : ($this->fiscalPositions[$fiscalPositionId] ?? null);

        // --- lines --------------------------------------------------------
        /** @var list<array<string, mixed>> $draft */
        $draft = [];

        if ($isRefund && $refundOf !== null) {
            foreach ($refundOf['lines'] as $line) {
                if (($line['comboParent'] ?? null) !== null) {
                    continue;
                }
                $draft[] = [
                    'variantId' => $line['variantId'],
                    'productId' => $line['productId'],
                    'categoryId' => $line['categoryId'],
                    'name' => $line['name'],
                    'quantity' => '-'.ltrim((string) $line['quantity'], '-'),
                    'priceUnit' => $line['priceUnit'],
                    'priceExtra' => $line['priceExtra'],
                    'discount' => $line['discount'],
                    'taxIds' => $line['taxIds'],
                    'uomId' => $line['uomId'],
                    'cost' => $line['cost'],
                    'note' => null,
                    'attributeValues' => [],
                    'comboParent' => null,
                    'comboId' => null,
                    'comboItemId' => null,
                    'refundedLineId' => $line['id'],
                ];
            }
        } else {
            $lineCount = $rng->int(1, 5);
            $useCombo = $this->comboProducts !== [] && $rng->chance(12);

            if ($useCombo) {
                $combo = $this->comboProducts[$rng->int(0, count($this->comboProducts) - 1)];
                $parentIndex = count($draft);
                $draft[] = $this->makeLine($combo, '1.000', $combo['basePrice'], '0', $rng, null);

                foreach ($this->comboChoices[$combo['productId']] ?? [] as $choice) {
                    $draft[] = [
                        'variantId' => $choice['variantId'],
                        'productId' => $choice['productId'],
                        'categoryId' => $choice['categoryId'],
                        'name' => $choice['name'],
                        'quantity' => '1.000',
                        'priceUnit' => $choice['extra'],
                        'priceExtra' => '0.0000',
                        'discount' => '0',
                        'taxIds' => $choice['taxIds'],
                        'uomId' => $choice['uomId'],
                        'cost' => $choice['cost'],
                        'note' => null,
                        'attributeValues' => [],
                        'comboParent' => $parentIndex,
                        'comboId' => $choice['comboId'],
                        'comboItemId' => $choice['itemId'],
                        'refundedLineId' => null,
                    ];
                }
                $lineCount = max(0, $lineCount - 2);
            }

            for ($i = 0; $i < $lineCount; $i++) {
                $product = $this->sellable[$rng->int(0, count($this->sellable) - 1)];

                $quantity = $product['toWeigh']
                    ? number_format($rng->int(120, 850) / 1000, 3, '.', '')
                    : number_format((float) $rng->int(1, 3), 3, '.', '');

                $discount = $rng->chance(8) ? (string) $rng->pick([5, 10, 15]) : '0';

                $draft[] = $this->makeLine($product, $quantity, $product['basePrice'], $discount, $rng, null);
            }

            // A tip is a real line on the "Pourboire" product, so it lands in the total.
            if ((bool) $config->enable_tips && $rng->chance(18)) {
                $tip = $this->tipLine();
                if ($tip !== null) {
                    $tip['priceUnit'] = number_format($rng->int(1, 6) * 0.5 + 1, 4, '.', '');
                    $draft[] = $tip;
                }
            }
        }

        if ($draft === []) {
            return null;
        }

        // --- tax engine ---------------------------------------------------
        $inputs = [];
        foreach ($draft as $index => $line) {
            $inputs[] = new LineInput(
                id: (string) $index,
                quantity: $line['quantity'],
                priceUnit: $line['priceUnit'],
                discount: $line['discount'],
                taxIds: $line['taxIds'],
            );
        }

        $result = $this->engine->compute(new OrderInput(
            currency: $this->currency,
            taxes: array_values($this->taxCatalog),
            lines: $inputs,
            roundingMethod: OrderInput::ROUND_PER_LINE,
            documentSign: '1',
            fiscalPosition: $fiscalPosition,
        ));

        $totals = $result->totals;

        // --- persist ------------------------------------------------------
        $this->orderCounter++;
        $employee = $this->employees[$rng->int(0, count($this->employees) - 1)];
        $customerId = $rng->chance(35) && $this->customerIds !== []
            ? $this->customerIds[$rng->int(0, count($this->customerIds) - 1)]
            : null;

        $tables = $this->tablesByConfig[$configId] ?? [];
        $tableId = ($isRestaurant && $presetName === PosConfigSeeder::PRESET_DINE_IN && $tables !== [])
            ? $tables[$rng->int(0, count($tables) - 1)]
            : null;

        $tipTotal = Decimal::zero();
        foreach ($draft as $index => $line) {
            if (($line['isTip'] ?? false) === true) {
                $tipTotal = $tipTotal->add($result->lines[$index]->priceTotal);
            }
        }

        $name = $isRefund
            ? $this->nextSequence('refund:'.$configId, $this->sessionPrefix($configName).'/R', 4)
            : $this->nextSequence('order:'.$configId, $this->sessionPrefix($configName).'-', 5);

        $totalCost = Decimal::zero();
        foreach ($draft as $line) {
            $totalCost = $totalCost->add(Decimal::of($line['cost'])->mul($line['quantity']));
        }

        $untaxed = Decimal::of($totals->totalExcluded);
        $margin = $untaxed->sub($totalCost);
        $marginPercent = $untaxed->isZero()
            ? Decimal::zero()
            : $margin->div($untaxed, 6)->mul('100');

        $state = $isDraft
            ? OrderState::Draft
            : (DB::table('pos_sessions')->where('id', $sessionId)->value('state') === SessionState::Opened->value
                ? OrderState::Paid
                : OrderState::Done);

        $orderUuid = Demo::uuid('order:'.$this->orderCounter);

        $orderId = (int) DB::table('pos_orders')->insertGetId([
            'uuid' => $orderUuid,
            'pos_session_id' => $sessionId,
            'pos_config_id' => $configId,
            'company_id' => $this->companyId,
            'pos_device_id' => DB::table('pos_devices')
                ->where('pos_config_id', $configId)->where('device_identifier', 1)->value('id'),
            'name' => $name,
            'receipt_number' => $isDraft ? null : str_replace(['-', '/'], '', $name),
            'tracking_number' => str_pad((string) ($this->orderCounter % 1000), 3, '0', STR_PAD_LEFT),
            'sequence_number' => $this->orderCounter,
            'access_token' => Demo::uuid('order-token:'.$this->orderCounter),
            'ticket_code' => strtoupper(Demo::token('ticket:'.$this->orderCounter, 5)),
            'source' => $rng->chance(12) ? OrderSource::Mobile->value : OrderSource::Pos->value,
            'state' => $state->value,
            'ordered_at' => Demo::ms($orderedAt),
            'paid_at' => $isDraft ? null : Demo::ms($orderedAt->modify('+35 minutes')),
            'closed_at' => $isDraft ? null : Demo::ms($orderedAt->modify('+36 minutes')),
            'customer_id' => $customerId,
            'employee_id' => $employee->id,
            'pricelist_id' => $config->pricelist_id,
            'fiscal_position_id' => $fiscalPositionId,
            'pos_preset_id' => $presetId,
            'currency_id' => $this->currencyId,
            'currency_rate' => '1.000000000000',
            'amount_untaxed' => $this->money(Decimal::of($totals->totalExcluded)),
            'amount_tax' => $this->money(Decimal::of($totals->totalTax)),
            'amount_total' => $this->money(Decimal::of($totals->totalIncluded)),
            'amount_rounding' => $this->money(Decimal::of($totals->roundingDelta)),
            'amount_paid' => '0.0000',
            'amount_change' => '0.0000',
            'amount_due' => $isDraft ? $this->money(Decimal::of($totals->totalIncluded)) : '0.0000',
            'amount_discount' => '0.0000',
            'total_cost' => $this->money($totalCost),
            'margin' => $this->money($margin),
            'margin_percent' => $marginPercent->withScale(4)->toString(),
            'tax_details' => json_encode($totals->toArray()['taxGroups'], JSON_THROW_ON_ERROR),
            'restaurant_table_id' => $tableId,
            'guest_count' => $tableId === null ? 0 : $rng->int(1, 6),
            'is_tipped' => ! $tipTotal->isZero(),
            'tip_amount' => $this->money($tipTotal),
            'is_refund' => $isRefund,
            'refunded_order_id' => $refundOf['orderId'] ?? null,
            'has_refundable_lines' => ! $isRefund,
            'to_invoice' => false,
            'general_customer_note' => $rng->chance(10) ? $rng->pick([
                'Table près de la fenêtre si possible.',
                'Allergie aux fruits à coque pour un convive.',
                'Servir les plats en même temps.',
                'Anniversaire — bougie sur le dessert.',
            ]) : null,
            'prep_state' => $isDraft ? OrderPrepState::Sent->value : OrderPrepState::Served->value,
            'unsent_change_count' => 0,
            'last_prep_sent_at' => Demo::ms($orderedAt->modify('+2 minutes')),
            'print_count' => $isDraft ? 0 : 1,
            'is_edited' => false,
            'has_deleted_line' => false,
            'client_created_at' => Demo::ms($orderedAt),
            'synced_at' => Demo::ms($orderedAt->modify('+1 minute')),
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        $courseIds = $isDraft ? $this->seedCourses($orderId, $orderedAt) : [];

        /** @var list<array<string, mixed>> $storedLines */
        $storedLines = [];
        /** @var array<int, int> $lineIdByIndex */
        $lineIdByIndex = [];
        $discountTotal = Decimal::zero();

        foreach ($draft as $index => $line) {
            $lineResult = $result->lines[$index];

            $signature = implode('-', array_map(
                static fn (array $tax): string => (string) $tax['taxId'],
                $lineResult->toArray()['taxes'],
            ));
            $signature = $signature === '' ? 'none' : $signature;

            $gross = Decimal::of($line['priceUnit'])->mul($line['quantity']);
            $discountAmount = $gross->mul(Decimal::of($line['discount']))->div('100', 4);

            $lineCost = Decimal::of($line['cost'])->mul($line['quantity']);

            $lineId = (int) DB::table('pos_order_lines')->insertGetId([
                'uuid' => Demo::uuid('order-line:'.$this->orderCounter.':'.$index),
                'pos_order_id' => $orderId,
                'company_id' => $this->companyId,
                'line_number' => $index + 1,
                'product_variant_id' => $line['variantId'],
                'product_id' => $line['productId'],
                'pos_category_id' => $line['categoryId'],
                'full_product_name' => $line['name'],
                'uom_id' => $line['uomId'],
                'quantity' => $line['quantity'],
                'price_unit' => $line['priceUnit'],
                'price_extra' => $line['priceExtra'],
                'price_type' => ($line['isTip'] ?? false) === true ? PriceType::Manual->value : PriceType::Original->value,
                'discount_percent' => number_format((float) $line['discount'], 4, '.', ''),
                'discount_amount' => $this->money($discountAmount),
                'price_subtotal' => $lineResult->priceSubtotal,
                'price_subtotal_incl' => $lineResult->priceTotal,
                'tax_details' => json_encode($lineResult->toArray()['taxes'], JSON_THROW_ON_ERROR),
                'tax_signature' => $signature,
                'unit_cost' => $line['cost'],
                'total_cost' => $this->money($lineCost),
                'margin' => $this->money(Decimal::of($lineResult->priceSubtotal)->sub($lineCost)),
                'customer_note' => $line['note'],
                'combo_parent_line_id' => $line['comboParent'] === null ? null : $lineIdByIndex[$line['comboParent']],
                'combo_id' => $line['comboId'],
                'combo_item_id' => $line['comboItemId'],
                'restaurant_course_id' => $courseIds === [] ? null : $courseIds[$index % count($courseIds)],
                'refunded_order_line_id' => $line['refundedLineId'],
                'refunded_quantity' => '0.000',
                'is_reward_line' => false,
                'points_cost' => '0.000',
                'is_edited' => false,
                'skip_preparation' => ($line['isTip'] ?? false) === true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $lineIdByIndex[$index] = $lineId;
            $discountTotal = $discountTotal->add($discountAmount);

            foreach ($line['attributeValues'] as $attributeValue) {
                DB::table('pos_order_line_attribute_value')->insert([
                    'pos_order_line_id' => $lineId,
                    'product_attribute_line_value_id' => $attributeValue['id'],
                    'price_extra' => $attributeValue['extra'],
                ]);
            }

            if ($line['refundedLineId'] !== null) {
                DB::table('pos_order_lines')->where('id', $line['refundedLineId'])->update([
                    'refunded_quantity' => ltrim((string) $line['quantity'], '-'),
                    'updated_at' => $this->now,
                ]);
            }

            $storedLines[] = [
                'id' => $lineId,
                'variantId' => $line['variantId'],
                'productId' => $line['productId'],
                'categoryId' => $line['categoryId'],
                'name' => $line['name'],
                'quantity' => $line['quantity'],
                'priceUnit' => $line['priceUnit'],
                'priceExtra' => $line['priceExtra'],
                'discount' => $line['discount'],
                'discountAmount' => $this->money($discountAmount),
                'taxIds' => $line['taxIds'],
                'uomId' => $line['uomId'],
                'cost' => $line['cost'],
                'subtotal' => $lineResult->priceSubtotal,
                'subtotalIncl' => $lineResult->priceTotal,
                'totalCost' => $this->money($lineCost),
                'signature' => $signature,
                'taxDetails' => $lineResult->toArray()['taxes'],
                'comboParent' => $line['comboParent'],
            ];
        }

        DB::table('pos_orders')->where('id', $orderId)->update([
            'amount_discount' => $this->money($discountTotal),
            'updated_at' => $this->now,
        ]);

        // --- payments -----------------------------------------------------
        $payments = [];
        $paid = Decimal::zero();
        $change = Decimal::zero();
        $cashNet = Decimal::zero();

        if (! $isDraft) {
            [$payments, $paid, $change, $cashNet] = $this->seedPayments(
                $orderId,
                $sessionId,
                $config,
                Decimal::of($totals->totalIncluded),
                $orderedAt,
                $employee,
                $customerId,
                $isRefund,
                $rng,
            );

            DB::table('pos_orders')->where('id', $orderId)->update([
                'amount_paid' => $this->money($paid),
                'amount_change' => $this->money($change),
                'amount_due' => $this->money(Decimal::of($totals->totalIncluded)->sub($paid)),
                'updated_at' => $this->now,
            ]);
        }

        if ($isDraft) {
            $this->seedPreparation($orderId, $configId, $storedLines, $orderedAt, $tableId);
        }

        if (! $isRefund && ! $isDraft && count($this->refundable) < 12 && $storedLines !== []) {
            $this->refundable[] = [
                'orderId' => $orderId,
                'lines' => $storedLines,
                'sessionId' => $sessionId,
                'configId' => $configId,
                'total' => $totals->totalIncluded,
            ];
        }

        return [
            'orderId' => $orderId,
            'lines' => $storedLines,
            'payments' => $payments,
            'total' => $totals->totalIncluded,
            'paid' => $this->money($paid),
            'cashNet' => $this->money($cashNet),
            'isRefund' => $isRefund,
        ];
    }

    /**
     * @param  array<string, mixed>  $product
     * @return array<string, mixed>
     */
    private function makeLine(array $product, string $quantity, string $price, string $discount, Demo $rng, ?string $note): array
    {
        $priceUnit = Decimal::of($price)->add($product['priceExtra'] ?? '0');
        $extra = Decimal::of($product['priceExtra'] ?? '0');

        /** @var list<array{id: int, extra: string}> $attributeValues */
        $attributeValues = [];
        foreach ($this->noVariantValues[$product['productId']] ?? [] as $candidate) {
            // One value per product is enough to show the feature on the receipt.
            if ($attributeValues === [] && $rng->chance(70)) {
                $attributeValues[] = ['id' => $candidate['id'], 'extra' => $candidate['extra']];
                $priceUnit = $priceUnit->add($candidate['extra']);
                $extra = $extra->add($candidate['extra']);
            }
        }

        return [
            'variantId' => $product['variantId'],
            'productId' => $product['productId'],
            'categoryId' => $product['categoryId'],
            'name' => $product['name'],
            'quantity' => $quantity,
            'priceUnit' => $priceUnit->withScale(4)->toString(),
            'priceExtra' => $extra->withScale(4)->toString(),
            'discount' => $discount,
            'taxIds' => $product['taxIds'],
            'uomId' => $product['uomId'],
            'cost' => $product['cost'],
            'note' => $note ?? ($rng->chance(10) ? $rng->pick(['Sans oignons', 'Sauce à part', 'Bien chaud', 'Sans glace']) : null),
            'attributeValues' => $attributeValues,
            'comboParent' => null,
            'comboId' => null,
            'comboItemId' => null,
            'refundedLineId' => null,
        ];
    }

    /** @return array<string, mixed>|null */
    private function tipLine(): ?array
    {
        static $tip = null;

        if ($tip === null) {
            $row = DB::table('product_variants as v')
                ->join('products as p', 'p.id', '=', 'v.product_id')
                ->where('p.company_id', $this->companyId)
                ->where('p.special_kind', 'tip')
                ->select(['v.id as variant_id', 'p.id as product_id', 'p.uom_id', 'p.name'])
                ->first();

            if ($row === null) {
                return null;
            }

            $tip = [
                'variantId' => (int) $row->variant_id,
                'productId' => (int) $row->product_id,
                'categoryId' => null,
                'name' => (string) $row->name,
                'quantity' => '1.000',
                'priceUnit' => '2.0000',
                'priceExtra' => '0.0000',
                'discount' => '0',
                'taxIds' => DB::table('product_tax')->where('product_id', $row->product_id)
                    ->pluck('tax_id')->map(static fn ($value): int => (int) $value)->all(),
                'uomId' => (int) $row->uom_id,
                'cost' => '0.0000',
                'note' => null,
                'attributeValues' => [],
                'comboParent' => null,
                'comboId' => null,
                'comboItemId' => null,
                'refundedLineId' => null,
                'isTip' => true,
            ];
        }

        return $tip;
    }

    /**
     * @return array{0: list<array{methodId: int, amount: string, isChange: bool, isRefund: bool}>, 1: Decimal, 2: Decimal, 3: Decimal}
     */
    private function seedPayments(
        int $orderId,
        int $sessionId,
        object $config,
        Decimal $total,
        DateTimeImmutable $orderedAt,
        object $employee,
        ?int $customerId,
        bool $isRefund,
        Demo $rng,
    ): array {
        $available = DB::table('pos_config_payment_method')
            ->where('pos_config_id', $config->id)
            ->join('payment_methods', 'payment_methods.id', '=', 'pos_config_payment_method.payment_method_id')
            ->where('payment_methods.method_type', '!=', 'online')
            ->orderBy('pos_config_payment_method.sequence')
            ->pluck('payment_methods.id')
            ->map(static fn ($value): int => (int) $value)
            ->all();

        $cashId = $this->paymentMethods[PosConfigSeeder::PM_CASH];

        /** @var list<array{methodId: int, amount: string, isChange: bool, isRefund: bool}> $payments */
        $payments = [];
        $change = Decimal::zero();

        if ($isRefund) {
            $payments[] = ['methodId' => $cashId, 'amount' => $this->money($total), 'isChange' => false, 'isRefund' => true];
        } elseif ($rng->chance(22) && count($available) > 1) {
            // A split bill: two (occasionally three) tenders that add up exactly.
            $parts = $rng->chance(25) ? 3 : 2;
            $remaining = $total;
            for ($i = 0; $i < $parts - 1; $i++) {
                $share = $total->mul((string) $rng->int(25, 50))->div('100', 2);
                $share = $share->withScale(2);
                if ($share->gte($remaining)) {
                    $share = $remaining->div('2', 2);
                }
                $remaining = $remaining->sub($share);
                $payments[] = [
                    'methodId' => $available[$i % count($available)],
                    'amount' => $this->money($share),
                    'isChange' => false,
                    'isRefund' => false,
                ];
            }
            $payments[] = [
                'methodId' => $available[($parts - 1) % count($available)],
                'amount' => $this->money($remaining),
                'isChange' => false,
                'isRefund' => false,
            ];
        } else {
            $methodId = $available[$rng->int(0, count($available) - 1)];

            if ($methodId === $cashId && $rng->chance(45)) {
                // Rounded-up tender with change given back.
                $cents = (int) round((float) $total->withScale(2)->toString() * 100);
                $step = $rng->pick([500, 1000, 2000]);
                $tenderCents = (int) (ceil($cents / $step) * $step);
                if ($tenderCents === $cents) {
                    $tenderCents += $step;
                }
                $tender = Decimal::of(number_format($tenderCents / 100, 2, '.', ''));
                $change = $tender->sub($total);

                $payments[] = ['methodId' => $methodId, 'amount' => $this->money($tender), 'isChange' => false, 'isRefund' => false];
                $payments[] = ['methodId' => $methodId, 'amount' => $this->money($change->negate()), 'isChange' => true, 'isRefund' => false];
            } else {
                $payments[] = ['methodId' => $methodId, 'amount' => $this->money($total), 'isChange' => false, 'isRefund' => false];
            }
        }

        $paid = Decimal::zero();
        $cashNet = Decimal::zero();
        $index = 0;

        foreach ($payments as $payment) {
            $amount = Decimal::of($payment['amount']);
            $paid = $paid->add($amount);
            if ($payment['methodId'] === $cashId) {
                $cashNet = $cashNet->add($amount);
            }

            $isCard = DB::table('payment_methods')->where('id', $payment['methodId'])->value('method_type') === 'card_terminal';

            DB::table('pos_payments')->insert([
                'uuid' => Demo::uuid('payment:'.$orderId.':'.$index),
                'pos_order_id' => $orderId,
                'pos_session_id' => $sessionId,
                'payment_method_id' => $payment['methodId'],
                'company_id' => $this->companyId,
                'currency_id' => $this->currencyId,
                'amount' => $payment['amount'],
                'amount_company_currency' => $payment['amount'],
                'is_change' => $payment['isChange'],
                'is_refund' => $payment['isRefund'],
                'label' => $payment['isChange'] ? 'Rendu monnaie' : null,
                'paid_at' => Demo::ms($orderedAt->modify('+'.(35 + $index).' minutes')),
                'customer_id' => $customerId,
                'employee_id' => $employee->id,
                'payment_status' => PaymentStatus::Done->value,
                'card_type' => $isCard ? 'credit' : null,
                'card_brand' => $isCard ? $rng->pick(['Visa', 'Mastercard', 'CB']) : null,
                'card_last4' => $isCard ? str_pad((string) $rng->int(0, 9999), 4, '0', STR_PAD_LEFT) : null,
                'auth_code' => $isCard ? strtoupper(Demo::token('auth:'.$orderId.':'.$index, 6)) : null,
                'transaction_reference' => $isCard ? 'TX-'.strtoupper(Demo::token('tx:'.$orderId.':'.$index, 10)) : null,
                'entry_mode' => $isCard ? $rng->pick(['contactless', 'chip', 'swipe']) : null,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $index++;
        }

        return [$payments, $paid, $change, $cashNet];
    }

    // --------------------------------------------------------- restaurant / KDS

    /** @return list<int> */
    private function seedCourses(int $orderId, DateTimeImmutable $orderedAt): array
    {
        $ids = [];
        foreach ([['Entrées', 1], ['Plat principal', 2]] as [$name, $courseIndex]) {
            $ids[] = (int) DB::table('restaurant_order_courses')->insertGetId([
                'uuid' => Demo::uuid('course:'.$orderId.':'.$courseIndex),
                'pos_order_id' => $orderId,
                'course_index' => $courseIndex,
                'name' => $name,
                'fired' => $courseIndex === 1,
                'fired_at' => $courseIndex === 1 ? Demo::ms($orderedAt->modify('+2 minutes')) : null,
                'line_count' => 0,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        return $ids;
    }

    /** @param  list<array<string, mixed>>  $lines */
    private function seedPreparation(int $orderId, int $configId, array $lines, DateTimeImmutable $orderedAt, ?int $tableId): void
    {
        $tableLabel = $tableId === null ? null : (string) DB::table('restaurant_tables')->where('id', $tableId)->value('name');

        DB::table('order_preparation_snapshots')->insert([
            'pos_order_id' => $orderId,
            'snapshot' => json_encode(array_map(static fn (array $line): array => [
                'uuid' => $line['id'],
                'product_id' => $line['productId'],
                'name' => $line['name'],
                'quantity' => $line['quantity'],
            ], $lines), JSON_THROW_ON_ERROR),
            'server_version' => 1,
            'server_date' => Demo::ms($orderedAt->modify('+2 minutes')),
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        foreach ($this->prepDisplays[$configId] ?? [] as $display) {
            $routed = array_values(array_filter(
                $lines,
                static fn (array $line): bool => $line['categoryId'] !== null
                    && in_array($line['categoryId'], $display['categories'], true),
            ));

            if ($routed === [] || $display['stages'] === []) {
                continue;
            }

            $prepOrderId = (int) DB::table('prep_orders')->insertGetId([
                'uuid' => Demo::uuid('prep-order:'.$orderId.':'.$display['id']),
                'prep_display_id' => $display['id'],
                'pos_order_id' => $orderId,
                'pos_config_id' => $configId,
                'tracking_number' => str_pad((string) ($orderId % 1000), 3, '0', STR_PAD_LEFT),
                'table_label' => $tableLabel,
                'guest_count' => 2,
                'preset_label' => 'Sur place',
                'state' => PrepOrderState::InProgress->value,
                'fired_at' => Demo::ms($orderedAt->modify('+2 minutes')),
                'first_started_at' => Demo::ms($orderedAt->modify('+4 minutes')),
                'is_recalled' => false,
                'sequence_in_display' => 1,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            foreach ($routed as $position => $line) {
                DB::table('prep_order_lines')->insert([
                    'uuid' => Demo::uuid('prep-line:'.$orderId.':'.$display['id'].':'.$position),
                    'prep_order_id' => $prepOrderId,
                    'pos_order_line_id' => $line['id'],
                    'pos_order_line_uuid' => (string) DB::table('pos_order_lines')->where('id', $line['id'])->value('uuid'),
                    'prep_stage_id' => $display['stages'][min(1, count($display['stages']) - 1)],
                    'course_index' => 1,
                    'product_id' => $line['productId'],
                    'pos_category_id' => $line['categoryId'],
                    'display_name' => $line['name'],
                    'quantity' => $line['quantity'],
                    'change_type' => PrepChangeType::New->value,
                    'state' => PrepLineState::InProgress->value,
                    'started_at' => Demo::ms($orderedAt->modify('+4 minutes')),
                    'fired_at' => Demo::ms($orderedAt->modify('+2 minutes')),
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }
        }
    }

    // --------------------------------------------------------------- invoicing

    /** Business customers get a real invoice document off their closed orders. */
    private function seedInvoices(): void
    {
        $orders = DB::table('pos_orders as o')
            ->join('customers as c', 'c.id', '=', 'o.customer_id')
            ->where('o.company_id', $this->companyId)
            ->where('o.state', OrderState::Done->value)
            ->where('o.is_refund', false)
            ->where('c.is_company', true)
            ->orderBy('o.id')
            ->select(['o.*', 'c.name as customer_name', 'c.vat', 'c.street', 'c.zip', 'c.city', 'c.email'])
            ->limit(3)
            ->get();

        $number = 1;
        foreach ($orders as $order) {
            $invoiceId = (int) DB::table('pos_invoices')->insertGetId([
                'uuid' => Demo::uuid('invoice:'.$order->id),
                'company_id' => $this->companyId,
                'pos_order_id' => $order->id,
                'number' => 'FA-'.Demo::clock()->format('Y').'-'.str_pad((string) $number, 5, '0', STR_PAD_LEFT),
                'invoice_type' => 'invoice',
                'customer_id' => $order->customer_id,
                'customer_snapshot' => json_encode([
                    'name' => $order->customer_name,
                    'vat' => $order->vat,
                    'street' => $order->street,
                    'zip' => $order->zip,
                    'city' => $order->city,
                    'email' => $order->email,
                ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
                'issued_at' => $order->paid_at,
                'currency_id' => $this->currencyId,
                'amount_untaxed' => $order->amount_untaxed,
                'amount_tax' => $order->amount_tax,
                'amount_total' => $order->amount_total,
                'tax_details' => (string) $order->tax_details,
                'state' => 'issued',
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $sortOrder = 0;
            foreach (DB::table('pos_order_lines')->where('pos_order_id', $order->id)->orderBy('id')->get() as $line) {
                DB::table('pos_invoice_lines')->insert([
                    'pos_invoice_id' => $invoiceId,
                    'pos_order_line_id' => $line->id,
                    'line_type' => 'product',
                    'description' => $line->full_product_name,
                    'quantity' => $line->quantity,
                    'price_unit' => $line->price_unit,
                    'discount_percent' => $line->discount_percent,
                    'price_subtotal' => $line->price_subtotal,
                    'price_subtotal_incl' => $line->price_subtotal_incl,
                    'tax_details' => $line->tax_details,
                    'sort_order' => $sortOrder++,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }

            DB::table('pos_orders')->where('id', $order->id)->update([
                'to_invoice' => true,
                'pos_invoice_id' => $invoiceId,
                'updated_at' => $this->now,
            ]);

            $number++;
        }

        DB::table('sequences')
            ->where('company_id', $this->companyId)
            ->whereNull('pos_config_id')
            ->where('purpose', 'invoice')
            ->update(['next_value' => $number, 'updated_at' => $this->now]);
    }

    /**
     * `order_edit_tracking` is on for every register, so a handful of orders
     * carry the audit trail the back-office screen is built to show.
     */
    private function seedEditLogs(Demo $rng): void
    {
        $lines = DB::table('pos_order_lines as l')
            ->join('pos_orders as o', 'o.id', '=', 'l.pos_order_id')
            ->where('o.company_id', $this->companyId)
            ->where('o.state', OrderState::Done->value)
            ->orderBy('l.id')
            ->select(['l.id', 'l.uuid', 'l.pos_order_id', 'l.full_product_name', 'l.quantity', 'l.price_unit', 'o.employee_id', 'o.ordered_at'])
            ->limit(60)
            ->get();

        $touched = [];
        $index = 0;
        foreach ($lines as $line) {
            if ($index++ % 7 !== 0) {
                continue;
            }

            $action = $rng->pick(['qty_increased', 'discount_changed', 'note_changed', 'line_removed']);
            $old = $action === 'qty_increased' ? (string) $line->quantity : '0';
            $new = $action === 'qty_increased' ? (string) ((float) $line->quantity + 1) : '10';

            DB::table('pos_order_edit_logs')->insert([
                'uuid' => Demo::uuid('edit-log:'.$line->id),
                'pos_order_id' => $line->pos_order_id,
                'pos_order_line_id' => $action === 'line_removed' ? null : $line->id,
                'pos_order_line_uuid' => $line->uuid,
                'action' => $action,
                'product_name' => $line->full_product_name,
                'old_value' => $old,
                'new_value' => $new,
                'amount_impact' => $action === 'qty_increased' ? $line->price_unit : '0.0000',
                'employee_id' => $line->employee_id,
                'occurred_at' => $line->ordered_at,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $touched[$line->pos_order_id] = true;
        }

        if ($touched !== []) {
            DB::table('pos_orders')->whereIn('id', array_keys($touched))
                ->update(['is_edited' => true, 'updated_at' => $this->now]);
        }
    }

    // ------------------------------------------------------------------- cash

    private function seedCashCount(int $sessionId, CashCountType $type, string $total, object $employee, DateTimeImmutable $countedAt): void
    {
        $countId = (int) DB::table('session_cash_counts')->insertGetId([
            'uuid' => Demo::uuid('cash-count:'.$sessionId.':'.$type->value),
            'pos_session_id' => $sessionId,
            'count_type' => $type->value,
            'total_counted' => $total,
            'counted_by_employee_id' => $employee->id,
            'counted_at' => Demo::ms($countedAt),
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        $remaining = (int) round((float) $total * 100);
        $sign = $remaining < 0 ? -1 : 1;
        $remaining = abs($remaining);

        foreach ($this->denominations as $denomination) {
            if ($denomination['cents'] <= 0 || $remaining < $denomination['cents']) {
                continue;
            }
            $quantity = intdiv($remaining, $denomination['cents']);
            $remaining -= $quantity * $denomination['cents'];

            DB::table('session_cash_count_lines')->insert([
                'session_cash_count_id' => $countId,
                'pos_bill_id' => $denomination['id'],
                'denomination_value' => $denomination['value'],
                'quantity' => $quantity,
                'subtotal' => number_format($sign * $quantity * $denomination['cents'] / 100, 4, '.', ''),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }
    }

    // ------------------------------------------------------------------ helpers

    private function money(Decimal $value): string
    {
        return $value->withScale(4)->toString();
    }

    private function sessionPrefix(string $configName): string
    {
        return match ($configName) {
            PosConfigSeeder::CONFIG_ROOM => 'SAL',
            PosConfigSeeder::CONFIG_BAR => 'BAR',
            PosConfigSeeder::CONFIG_COUNTER => 'CPT',
            default => 'BOR',
        };
    }

    private function nextSequence(string $key, string $prefix, int $padding): string
    {
        $this->sequenceCounters[$key] = ($this->sequenceCounters[$key] ?? 0) + 1;

        return $prefix.str_pad((string) $this->sequenceCounters[$key], $padding, '0', STR_PAD_LEFT);
    }

    /** Leave the atomic counters where the demo data stopped. */
    private function bumpSequences(): void
    {
        foreach (DB::table('pos_configs')->where('company_id', $this->companyId)->get() as $config) {
            $orders = DB::table('pos_orders')->where('pos_config_id', $config->id)->count();
            $sessions = DB::table('pos_sessions')->where('pos_config_id', $config->id)->count();
            $refunds = DB::table('pos_orders')->where('pos_config_id', $config->id)->where('is_refund', true)->count();

            DB::table('sequences')->where('pos_config_id', $config->id)
                ->where('purpose', 'order')->update(['next_value' => $orders + 1, 'updated_at' => $this->now]);
            DB::table('sequences')->where('pos_config_id', $config->id)
                ->where('purpose', 'receipt')->update(['next_value' => $orders + 1, 'updated_at' => $this->now]);
            DB::table('sequences')->where('pos_config_id', $config->id)
                ->where('purpose', 'session')->update(['next_value' => $sessions + 1, 'updated_at' => $this->now]);
            DB::table('sequences')->where('pos_config_id', $config->id)
                ->where('purpose', 'refund')->update(['next_value' => $refunds + 1, 'updated_at' => $this->now]);
        }
    }

    private function refreshCustomerStats(): void
    {
        $stats = DB::table('pos_orders')
            ->where('company_id', $this->companyId)
            ->whereNotNull('customer_id')
            ->where('is_refund', false)
            ->selectRaw('customer_id, count(*) as order_count, max(ordered_at) as last_order_at')
            ->groupBy('customer_id')
            ->get();

        foreach ($stats as $row) {
            DB::table('customers')->where('id', $row->customer_id)->update([
                'order_count' => (int) $row->order_count,
                'last_order_at' => $row->last_order_at,
                'updated_at' => $this->now,
            ]);
        }
    }
}
