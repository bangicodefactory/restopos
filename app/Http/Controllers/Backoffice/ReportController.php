<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\OrderState;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use App\Services\Pos\SessionSummaryService;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Reports/SalesDetails`, `Reports/SessionReport`, `Reports/OrderAnalytics`
 * (spec 02 BOF-160…BOF-189).
 *
 * Every figure comes from the **frozen** `session_*_summaries` tables where one
 * exists, and from the order rows only for still-open sessions. Mixing the two
 * silently is how a report drifts from the ledger.
 */
final class ReportController extends Controller
{
    /** @var array<string, array<int, string>> display-name lookups, memoised per request */
    private array $names = [];

    public function __construct(
        private readonly ConnectionInterface $connection,
        private readonly SessionSummaryService $summaries,
    ) {}

    /**
     * Validate a `config_id` filter against the acting company, or 404.
     *
     * `nullable|integer` is not a tenancy check. Without this a user could name another company's
     * register and get that register's trade back, filtered to exactly the competitor they asked
     * for. The lookup goes through the scoped model, so a foreign id simply does not resolve.
     */
    private function tenantConfigId(mixed $configId): ?int
    {
        if ($configId === null || $configId === '') {
            return null;
        }

        return (int) PosConfig::query()->findOrFail((int) $configId)->getKey();
    }

    /** X/Z report equivalent: sales by category, product and tax for a period. */
    public function salesDetails(Request $request): Response
    {
        $data = $request->validate([
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'config_id' => ['nullable', 'integer'],
        ]);

        $from = (string) ($data['from'] ?? now()->startOfMonth()->toDateString());
        $to = (string) ($data['to'] ?? now()->toDateString());

        $configId = $this->tenantConfigId($data['config_id'] ?? null);

        // Every figure below is keyed off this list, and `session_sales_summaries` and friends carry
        // no `company_id` of their own — so scoping the sessions is what isolates the whole report.
        // Unscoped, this aggregated every tenant's trade into one page (XCT-101).
        $sessions = $this->connection->table('pos_sessions')
            ->whereBetween('business_date', [$from, $to])
            ->when($configId, fn ($q, $c) => $q->where('pos_config_id', $c));

        ActingCompany::scope($sessions);

        $sessionIds = $sessions->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        [$frozenIds, $liveIds] = $this->splitBySummaryState($sessionIds);

        // Sales rows for the whole period: frozen where they exist, computed live where they do not
        // (BOF-160). Concatenated rather than summed here — the panels below each group them their
        // own way, and grouping twice would be the only way to get the arithmetic wrong.
        $sales = [
            ...$this->frozenSales($frozenIds),
            ...$this->summaries->salesSummaryRows($liveIds),
        ];

        $taxes = [
            ...$this->frozenTaxes($frozenIds),
            ...$this->summaries->taxSummaryRows($liveIds),
        ];

        $this->loadNames('products', $sales, 'product_id');
        $this->loadNames('pos_categories', $sales, 'pos_category_id');
        $this->loadNames('taxes', $taxes, 'tax_id');

        return Inertia::render('Reports/SalesDetails', [
            'filters' => ['from' => $from, 'to' => $to, 'config_id' => $configId],
            'openSessionCount' => count($liveIds),
            'byProduct' => $this->group(
                $sales,
                static fn (array $row): string => (string) ($row['product_id'] ?? ''),
                ['quantity', 'base_amount', 'tax_amount', 'total_amount', 'cost_amount'],
                fn (array $row): array => [
                    'product_id' => $row['product_id'],
                    'product_name' => $this->nameOf('products', $row['product_id']),
                ],
            ),
            'byCategory' => $this->group(
                $sales,
                static fn (array $row): string => (string) ($row['pos_category_id'] ?? ''),
                ['quantity', 'total_amount'],
                fn (array $row): array => [
                    'pos_category_id' => $row['pos_category_id'],
                    'category_name' => $this->nameOf('pos_categories', $row['pos_category_id']),
                ],
            ),
            'byTax' => $this->group(
                $taxes,
                static fn (array $row): string => (string) ($row['tax_id'] ?? ''),
                ['base_amount', 'tax_amount'],
                fn (array $row): array => [
                    'tax_id' => $row['tax_id'],
                    'tax_name' => $this->nameOf('taxes', $row['tax_id']),
                ],
                'base_amount',
            ),
            'byPaymentMethod' => $this->paymentPanel($frozenIds, $liveIds),
        ]);
    }

    /**
     * Which of these sessions already have frozen summaries, and which must be computed live.
     *
     * Keyed on the presence of the rows rather than on the session's state, and that is the whole
     * defence against double-counting: a session cannot be in both lists, because the question asked
     * is literally "do we already hold a frozen answer for this one?". Keying on `state = closed`
     * would read the same most of the time and then quietly report zero for a session whose close
     * wrote no summaries.
     *
     * @param  list<int>  $sessionIds
     * @return array{0: list<int>, 1: list<int>}
     */
    private function splitBySummaryState(array $sessionIds): array
    {
        if ($sessionIds === []) {
            return [[], []];
        }

        $frozen = $this->connection->table('session_sales_summaries')
            ->whereIn('pos_session_id', $sessionIds)
            ->distinct()
            ->pluck('pos_session_id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        return [$frozen, array_values(array_diff($sessionIds, $frozen))];
    }

    /**
     * @param  list<int>  $sessionIds
     * @return list<array<string, mixed>>
     */
    private function frozenSales(array $sessionIds): array
    {
        if ($sessionIds === []) {
            return [];
        }

        return $this->connection->table('session_sales_summaries')
            ->whereIn('pos_session_id', $sessionIds)
            ->get()
            ->map(static fn (object $row): array => (array) $row)
            ->all();
    }

    /**
     * @param  list<int>  $sessionIds
     * @return list<array<string, mixed>>
     */
    private function frozenTaxes(array $sessionIds): array
    {
        if ($sessionIds === []) {
            return [];
        }

        return $this->connection->table('session_tax_summaries')
            ->whereIn('pos_session_id', $sessionIds)
            ->get()
            ->map(static fn (object $row): array => (array) $row)
            ->all();
    }

    /**
     * Payments: frozen `expected_amount` for closed sessions, live totals for open ones.
     *
     * `difference_amount` is only ever a closed-session number — it is the drawer count minus what
     * was expected, and nobody has counted the drawer of a service still running. Reporting a live
     * session's difference as `0` would look like "counted and balanced" rather than "not counted".
     *
     * @param  list<int>  $frozenIds
     * @param  list<int>  $liveIds
     * @return list<array<string, mixed>>
     */
    private function paymentPanel(array $frozenIds, array $liveIds): array
    {
        $rows = [];

        if ($frozenIds !== []) {
            foreach ($this->connection->table('session_payment_totals')->whereIn('pos_session_id', $frozenIds)->get() as $row) {
                $rows[] = (array) $row;
            }
        }

        foreach ($this->summaries->paymentTotalRows($liveIds) as $row) {
            $rows[] = [...$row, 'difference_amount' => '0'];
        }

        $this->loadNames('payment_methods', $rows, 'payment_method_id');

        return $this->group(
            $rows,
            static fn (array $row): string => (string) ($row['payment_method_id'] ?? ''),
            ['expected_amount', 'difference_amount'],
            fn (array $row): array => [
                'payment_method_id' => $row['payment_method_id'],
                'method_name' => $this->nameOf('payment_methods', $row['payment_method_id']),
            ],
            'expected_amount',
        );
    }

    /**
     * Sum `$fields` across `$rows`, grouped by `$keyOf`, sorted by the first field descending.
     *
     * Frozen rows and live rows have the same column names by construction — one is the persisted
     * form of the other — so they add up without a translation step. The sums use `bcadd` rather
     * than PHP floats for the same reason the rest of the codebase does: these are money.
     *
     * `$sortBy` is named rather than inferred from `$fields[0]`. Inferring it silently ranked
     * `byProduct` by quantity, because that is the first field summed — so the report's headline
     * list put cheap high-volume items above the ones that actually earn, which is the opposite of
     * what a manager opens this page for.
     *
     * @param  list<array<string, mixed>>  $rows
     * @param  callable(array<string, mixed>): string  $keyOf
     * @param  list<string>  $fields
     * @param  callable(array<string, mixed>): array<string, mixed>  $identity
     * @return list<array<string, mixed>>
     */
    private function group(array $rows, callable $keyOf, array $fields, callable $identity, string $sortBy = 'total_amount'): array
    {
        $out = [];

        foreach ($rows as $row) {
            $key = $keyOf($row);

            if (! isset($out[$key])) {
                $out[$key] = $identity($row);

                foreach ($fields as $field) {
                    $out[$key][$field] = '0';
                }
            }

            foreach ($fields as $field) {
                $out[$key][$field] = bcadd($out[$key][$field], (string) ($row[$field] ?? '0'), 4);
            }
        }

        if (in_array($sortBy, $fields, true)) {
            uasort($out, static fn (array $a, array $b): int => bccomp((string) $b[$sortBy], (string) $a[$sortBy], 4));
        }

        return array_values($out);
    }

    /**
     * Load display names for exactly the ids in the result set.
     *
     * The panels used to get these from `leftJoin`s. Live rows do not come from a table that can be
     * joined, so the lookup moved into PHP — but it has to stay as narrow as the join was. Reading
     * the whole table and indexing it in memory worked on a seeded catalogue of 74 products and
     * would load every product, category and tax of every company on a real one, to label a few
     * dozen rows.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function loadNames(string $table, array $rows, string $column): void
    {
        $ids = [];

        foreach ($rows as $row) {
            $id = $row[$column] ?? null;

            if ($id !== null && $id !== '') {
                $ids[(int) $id] = true;
            }
        }

        $this->names[$table] = $ids === []
            ? []
            : $this->connection->table($table)->whereIn('id', array_keys($ids))->pluck('name', 'id')->all();
    }

    /** A display name for an id, from the set loaded by {@see loadNames}. */
    private function nameOf(string $table, mixed $id): ?string
    {
        if ($id === null || $id === '') {
            return null;
        }

        return isset($this->names[$table][(int) $id]) ? (string) $this->names[$table][(int) $id] : null;
    }

    /** One session, end to end: the Z-report a manager signs. */
    public function sessionReport(Request $request): Response
    {
        $request->validate(['session_id' => ['required', 'integer']]);

        // `session_id` is whatever the caller typed. Resolving it through the scoped model rather
        // than the raw table is what stops one manager reading another company's Z-report by
        // guessing an id — `findOrFail` 404s because the row is not in their scope at all.
        $session = PosSession::query()->findOrFail($request->integer('session_id'));
        $sessionId = $session->getKey();

        return Inertia::render('Reports/SessionReport', [
            'session' => $session->attributesToArray(),
            'paymentTotals' => $this->connection->table('session_payment_totals')->where('pos_session_id', $sessionId)
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'salesSummaries' => $this->connection->table('session_sales_summaries')->where('pos_session_id', $sessionId)
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'taxSummaries' => $this->connection->table('session_tax_summaries')->where('pos_session_id', $sessionId)
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'cashMovements' => $this->connection->table('cash_movements')->where('pos_session_id', $sessionId)
                ->whereNull('deleted_at')->get()->map(static fn ($r): array => (array) $r)->all(),
        ]);
    }

    /** Trends: orders per hour, average basket, refund rate (BOF-170…189). */
    public function orderAnalytics(Request $request): Response
    {
        $data = $request->validate([
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'config_id' => ['nullable', 'integer'],
        ]);

        $from = (string) ($data['from'] ?? now()->subDays(30)->toDateString());
        $to = (string) ($data['to'] ?? now()->toDateString());

        $configId = $this->tenantConfigId($data['config_id'] ?? null);

        $base = $this->connection->table('pos_orders')
            ->whereBetween('ordered_at', [$from.' 00:00:00', $to.' 23:59:59'])
            ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('deleted_at')
            ->when($configId, fn ($q, $c) => $q->where('pos_config_id', $c));

        ActingCompany::scope($base);

        $totals = (clone $base)
            ->selectRaw('count(*) as order_count')
            ->selectRaw('coalesce(sum(amount_total), 0) as revenue')
            ->selectRaw('coalesce(sum(case when is_refund then 1 else 0 end), 0) as refund_count')
            ->selectRaw('coalesce(sum(guest_count), 0) as guests')
            ->first();

        return Inertia::render('Reports/OrderAnalytics', [
            'filters' => ['from' => $from, 'to' => $to, 'config_id' => $configId],
            'totals' => (array) ($totals ?? []),
            'bySource' => (clone $base)->groupBy('source')
                ->selectRaw('source')->selectRaw('count(*) as order_count')->selectRaw('coalesce(sum(amount_total), 0) as revenue')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'byDay' => (clone $base)->groupByRaw('date(ordered_at)')
                ->selectRaw('date(ordered_at) as day')->selectRaw('count(*) as order_count')->selectRaw('coalesce(sum(amount_total), 0) as revenue')
                ->orderByRaw('date(ordered_at)')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
        ]);
    }
}
