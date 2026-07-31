<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\OrderState;
use App\Http\Controllers\Controller;
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
    public function __construct(private readonly ConnectionInterface $connection) {}

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

        $sessionIds = $this->connection->table('pos_sessions')
            ->whereBetween('business_date', [$from, $to])
            ->when($data['config_id'] ?? null, fn ($q, $c) => $q->where('pos_config_id', (int) $c))
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        return Inertia::render('Reports/SalesDetails', [
            'filters' => ['from' => $from, 'to' => $to, 'config_id' => $data['config_id'] ?? null],
            'byProduct' => $sessionIds === [] ? [] : $this->connection->table('session_sales_summaries')
                ->leftJoin('products', 'products.id', '=', 'session_sales_summaries.product_id')
                ->whereIn('pos_session_id', $sessionIds)
                ->groupBy('session_sales_summaries.product_id', 'products.name')
                ->selectRaw('session_sales_summaries.product_id as product_id')
                ->selectRaw('products.name as product_name')
                ->selectRaw('sum(quantity) as quantity')
                ->selectRaw('sum(base_amount) as base_amount')
                ->selectRaw('sum(tax_amount) as tax_amount')
                ->selectRaw('sum(total_amount) as total_amount')
                ->selectRaw('sum(cost_amount) as cost_amount')
                ->orderByDesc('total_amount')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'byCategory' => $sessionIds === [] ? [] : $this->connection->table('session_sales_summaries')
                ->leftJoin('pos_categories', 'pos_categories.id', '=', 'session_sales_summaries.pos_category_id')
                ->whereIn('pos_session_id', $sessionIds)
                ->groupBy('session_sales_summaries.pos_category_id', 'pos_categories.name')
                ->selectRaw('session_sales_summaries.pos_category_id as pos_category_id')
                ->selectRaw('pos_categories.name as category_name')
                ->selectRaw('sum(quantity) as quantity')
                ->selectRaw('sum(total_amount) as total_amount')
                ->orderByDesc('total_amount')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'byTax' => $sessionIds === [] ? [] : $this->connection->table('session_tax_summaries')
                ->join('taxes', 'taxes.id', '=', 'session_tax_summaries.tax_id')
                ->whereIn('pos_session_id', $sessionIds)
                ->groupBy('session_tax_summaries.tax_id', 'taxes.name')
                ->selectRaw('session_tax_summaries.tax_id as tax_id')
                ->selectRaw('taxes.name as tax_name')
                ->selectRaw('sum(base_amount) as base_amount')
                ->selectRaw('sum(tax_amount) as tax_amount')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'byPaymentMethod' => $sessionIds === [] ? [] : $this->connection->table('session_payment_totals')
                ->join('payment_methods', 'payment_methods.id', '=', 'session_payment_totals.payment_method_id')
                ->whereIn('pos_session_id', $sessionIds)
                ->groupBy('session_payment_totals.payment_method_id', 'payment_methods.name')
                ->selectRaw('session_payment_totals.payment_method_id as payment_method_id')
                ->selectRaw('payment_methods.name as method_name')
                ->selectRaw('sum(expected_amount) as expected_amount')
                ->selectRaw('sum(difference_amount) as difference_amount')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
        ]);
    }

    /** One session, end to end: the Z-report a manager signs. */
    public function sessionReport(Request $request): Response
    {
        $request->validate(['session_id' => ['required', 'integer']]);

        $sessionId = $request->integer('session_id');

        return Inertia::render('Reports/SessionReport', [
            'session' => (array) ($this->connection->table('pos_sessions')->where('id', $sessionId)->first() ?? []),
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

        $base = $this->connection->table('pos_orders')
            ->whereBetween('ordered_at', [$from.' 00:00:00', $to.' 23:59:59'])
            ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('deleted_at')
            ->when($data['config_id'] ?? null, fn ($q, $c) => $q->where('pos_config_id', (int) $c));

        $totals = (clone $base)
            ->selectRaw('count(*) as order_count')
            ->selectRaw('coalesce(sum(amount_total), 0) as revenue')
            ->selectRaw('coalesce(sum(case when is_refund then 1 else 0 end), 0) as refund_count')
            ->selectRaw('coalesce(sum(guest_count), 0) as guests')
            ->first();

        return Inertia::render('Reports/OrderAnalytics', [
            'filters' => ['from' => $from, 'to' => $to, 'config_id' => $data['config_id'] ?? null],
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
