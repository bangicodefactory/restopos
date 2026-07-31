<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\OrderState;
use App\Models\Pos\PosSession;
use Illuminate\Database\ConnectionInterface;

/**
 * Freezes a closed session's figures into `session_payment_totals`,
 * `session_sales_summaries` and `session_tax_summaries` (spec 01-schema §2.E).
 *
 * These tables are the accounting-facing truth: once written they are never
 * recomputed from the order rows, so a later correction to an order cannot
 * silently rewrite a period that has already been exported. Everything is
 * aggregated in SQL — this runs once per session close, on possibly thousands
 * of lines, and pulling them into PHP would be pointless.
 */
final readonly class SessionSummaryService
{
    public function __construct(private ConnectionInterface $connection) {}

    /**
     * Compute + persist all three summary tables.
     *
     * @param  array<int, string>  $countedByMethod  payment_method_id => counted amount
     * @return array<string, mixed>
     */
    public function freeze(PosSession $session, array $countedByMethod = []): array
    {
        $payments = $this->writePaymentTotals($session, $countedByMethod);
        $sales = $this->writeSalesSummaries($session);
        $taxes = $this->writeTaxSummaries($session);

        $orderTotals = $this->orderTotals($session);

        $session->forceFill([
            'order_count' => $orderTotals['order_count'],
            'order_amount_total' => $orderTotals['order_amount_total'],
            'refund_amount_total' => $orderTotals['refund_amount_total'],
            'payments_total' => $orderTotals['payments_total'],
        ])->save();

        return [
            'payment_totals' => $payments,
            'sales_summaries' => $sales,
            'tax_summaries' => $taxes,
            'orders' => $orderTotals,
        ];
    }

    /**
     * Per-method expected amounts, live (used by the closing popup before the
     * session is actually closed).
     *
     * @return list<array{payment_method_id: int, name: string, is_cash_count: bool, expected_amount: string, payment_count: int, refund_amount: string, change_amount: string}>
     */
    public function expectedPaymentTotals(PosSession $session): array
    {
        $rows = $this->connection->table('pos_payments')
            ->join('payment_methods', 'payment_methods.id', '=', 'pos_payments.payment_method_id')
            ->where('pos_payments.pos_session_id', $session->getKey())
            ->whereNull('pos_payments.deleted_at')
            ->groupBy('pos_payments.payment_method_id', 'payment_methods.name', 'payment_methods.is_cash_count', 'payment_methods.ledger_code')
            ->selectRaw('pos_payments.payment_method_id as payment_method_id')
            ->selectRaw('payment_methods.name as name')
            ->selectRaw('payment_methods.is_cash_count as is_cash_count')
            ->selectRaw('payment_methods.ledger_code as ledger_code')
            ->selectRaw('sum(pos_payments.amount) as expected_amount')
            ->selectRaw('count(*) as payment_count')
            ->selectRaw('sum(case when pos_payments.is_refund then pos_payments.amount else 0 end) as refund_amount')
            ->selectRaw('sum(case when pos_payments.is_change then pos_payments.amount else 0 end) as change_amount')
            ->get();

        $out = [];

        foreach ($rows as $row) {
            $out[] = [
                'payment_method_id' => (int) $row->payment_method_id,
                'name' => (string) $row->name,
                'is_cash_count' => (bool) $row->is_cash_count,
                'ledger_code' => $row->ledger_code === null ? null : (string) $row->ledger_code,
                'expected_amount' => $this->scale((string) ($row->expected_amount ?? '0')),
                'payment_count' => (int) $row->payment_count,
                'refund_amount' => $this->scale((string) ($row->refund_amount ?? '0')),
                'change_amount' => $this->scale((string) ($row->change_amount ?? '0')),
            ];
        }

        return $out;
    }

    /**
     * @param  array<int, string>  $countedByMethod
     * @return list<array<string, mixed>>
     */
    private function writePaymentTotals(PosSession $session, array $countedByMethod): array
    {
        $this->connection->table('session_payment_totals')->where('pos_session_id', $session->getKey())->delete();

        $rows = $this->expectedPaymentTotals($session);
        $now = now();

        foreach ($rows as $index => $row) {
            $counted = $countedByMethod[$row['payment_method_id']] ?? null;
            $difference = $counted === null ? '0' : bcsub($counted, $row['expected_amount'], 4);

            $rows[$index]['counted_amount'] = $counted;
            $rows[$index]['difference_amount'] = $difference;

            $this->connection->table('session_payment_totals')->insert([
                'pos_session_id' => $session->getKey(),
                'payment_method_id' => $row['payment_method_id'],
                'currency_id' => $session->currency_id,
                'expected_amount' => $row['expected_amount'],
                'counted_amount' => $counted,
                'difference_amount' => $difference,
                'payment_count' => $row['payment_count'],
                'refund_amount' => $row['refund_amount'],
                'change_amount' => $row['change_amount'],
                'ledger_code' => $row['ledger_code'],
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }

        return $rows;
    }

    /** @return list<array<string, mixed>> */
    private function writeSalesSummaries(PosSession $session): array
    {
        $this->connection->table('session_sales_summaries')->where('pos_session_id', $session->getKey())->delete();

        $rows = $this->connection->table('pos_order_lines')
            ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
            ->where('pos_orders.pos_session_id', $session->getKey())
            ->whereIn('pos_orders.state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('pos_orders.deleted_at')
            ->whereNull('pos_order_lines.deleted_at')
            ->groupBy('pos_order_lines.pos_category_id', 'pos_order_lines.product_id', 'pos_order_lines.tax_signature', 'pos_orders.is_refund')
            ->selectRaw('pos_order_lines.pos_category_id as pos_category_id')
            ->selectRaw('pos_order_lines.product_id as product_id')
            ->selectRaw('pos_order_lines.tax_signature as tax_signature')
            ->selectRaw('pos_orders.is_refund as is_refund')
            ->selectRaw('sum(pos_order_lines.quantity) as quantity')
            ->selectRaw('sum(pos_order_lines.price_subtotal) as base_amount')
            ->selectRaw('sum(pos_order_lines.discount_amount) as discount_amount')
            ->selectRaw('sum(pos_order_lines.price_subtotal_incl - pos_order_lines.price_subtotal) as tax_amount')
            ->selectRaw('sum(pos_order_lines.price_subtotal_incl) as total_amount')
            ->selectRaw('sum(pos_order_lines.total_cost) as cost_amount')
            ->get();

        $now = now();
        $out = [];

        foreach ($rows as $row) {
            $record = [
                'pos_session_id' => $session->getKey(),
                'pos_category_id' => $row->pos_category_id === null ? null : (int) $row->pos_category_id,
                'product_id' => $row->product_id === null ? null : (int) $row->product_id,
                'tax_signature' => (string) $row->tax_signature,
                'is_refund' => (bool) $row->is_refund,
                'quantity' => $this->scale((string) ($row->quantity ?? '0'), 3),
                'base_amount' => $this->scale((string) ($row->base_amount ?? '0')),
                'discount_amount' => $this->scale((string) ($row->discount_amount ?? '0')),
                'tax_amount' => $this->scale((string) ($row->tax_amount ?? '0')),
                'total_amount' => $this->scale((string) ($row->total_amount ?? '0')),
                'cost_amount' => $this->scale((string) ($row->cost_amount ?? '0')),
                'ledger_code' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ];

            $this->connection->table('session_sales_summaries')->insert($record);
            $out[] = $record;
        }

        return $out;
    }

    /**
     * Tax summaries come out of each line's frozen `tax_details` JSON, not out
     * of a re-run of the engine: the numbers on the receipt and the numbers in
     * the ledger must be the same numbers.
     *
     * @return list<array<string, mixed>>
     */
    private function writeTaxSummaries(PosSession $session): array
    {
        $this->connection->table('session_tax_summaries')->where('pos_session_id', $session->getKey())->delete();

        $lines = $this->connection->table('pos_order_lines')
            ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
            ->where('pos_orders.pos_session_id', $session->getKey())
            ->whereIn('pos_orders.state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('pos_orders.deleted_at')
            ->whereNull('pos_order_lines.deleted_at')
            ->select(['pos_order_lines.tax_details', 'pos_orders.is_refund'])
            ->get();

        /** @var array<string, array{tax_id: int, is_refund: bool, base: string, amount: string}> $buckets */
        $buckets = [];

        foreach ($lines as $line) {
            /** @var list<array{taxId?: int, tax_id?: int, base?: string, amount?: string}> $details */
            $details = json_decode((string) ($line->tax_details ?? '[]'), true) ?: [];
            $isRefund = (bool) $line->is_refund;

            foreach ($details as $detail) {
                $taxId = (int) ($detail['taxId'] ?? $detail['tax_id'] ?? 0);

                if ($taxId === 0) {
                    continue;
                }

                $key = $taxId.':'.($isRefund ? '1' : '0');
                $buckets[$key] ??= ['tax_id' => $taxId, 'is_refund' => $isRefund, 'base' => '0', 'amount' => '0'];
                $buckets[$key]['base'] = bcadd($buckets[$key]['base'], (string) ($detail['base'] ?? '0'), 4);
                $buckets[$key]['amount'] = bcadd($buckets[$key]['amount'], (string) ($detail['amount'] ?? '0'), 4);
            }
        }

        if ($buckets === []) {
            return [];
        }

        $taxMeta = $this->connection->table('taxes')
            ->whereIn('id', array_column($buckets, 'tax_id'))
            ->get()
            ->keyBy('id');

        $now = now();
        $out = [];

        foreach ($buckets as $bucket) {
            $meta = $taxMeta->get($bucket['tax_id']);

            if ($meta === null) {
                continue;
            }

            $record = [
                'pos_session_id' => $session->getKey(),
                'tax_id' => $bucket['tax_id'],
                'tax_group_id' => (int) $meta->tax_group_id,
                'is_refund' => $bucket['is_refund'],
                'base_amount' => $bucket['base'],
                'tax_amount' => $bucket['amount'],
                'tax_rate' => (string) $meta->amount,
                'created_at' => $now,
                'updated_at' => $now,
            ];

            $this->connection->table('session_tax_summaries')->insert($record);
            $out[] = $record;
        }

        return $out;
    }

    /** @return array{order_count: int, order_amount_total: string, refund_amount_total: string, payments_total: string} */
    private function orderTotals(PosSession $session): array
    {
        $row = $this->connection->table('pos_orders')
            ->where('pos_session_id', $session->getKey())
            ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
            ->whereNull('deleted_at')
            ->selectRaw('count(*) as order_count')
            ->selectRaw('sum(case when is_refund then 0 else amount_total end) as order_amount_total')
            ->selectRaw('sum(case when is_refund then amount_total else 0 end) as refund_amount_total')
            ->first();

        $payments = (string) ($this->connection->table('pos_payments')
            ->where('pos_session_id', $session->getKey())
            ->whereNull('deleted_at')
            ->sum('amount') ?? '0');

        return [
            'order_count' => (int) ($row->order_count ?? 0),
            'order_amount_total' => $this->scale((string) ($row->order_amount_total ?? '0')),
            'refund_amount_total' => $this->scale((string) ($row->refund_amount_total ?? '0')),
            'payments_total' => $this->scale($payments),
        ];
    }

    private function scale(string $value, int $scale = 4): string
    {
        return bcadd($value === '' ? '0' : $value, '0', $scale);
    }
}
