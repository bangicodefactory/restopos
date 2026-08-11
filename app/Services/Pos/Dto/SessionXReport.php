<?php

declare(strict_types=1);

namespace App\Services\Pos\Dto;

use App\Services\Pos\SessionSummaryService;

/**
 * The X-report: what this session has taken so far, without closing it (REG-020, REG-022).
 *
 * A Z-report is the end of a shift and happens once. An X-report is the same figures asked for
 * mid-service — at a shift handover, before a bank run, or when a manager simply wants to know how
 * the day is going — and asking must not end the day.
 *
 * Every number here comes from {@see SessionSummaryService}'s **live** row
 * aggregations, which are the same queries `freeze()` persists at close. That is what makes the
 * acceptance criterion true by construction rather than by test: an X-report printed at 18:00 and
 * the Z-report printed at midnight cannot disagree about the orders they both cover, because
 * neither has its own arithmetic.
 */
final readonly class SessionXReport
{
    /**
     * @param  list<array<string, mixed>>  $salesRows  live `session_sales_summaries` shape
     * @param  list<array<string, mixed>>  $taxRows  live `session_tax_summaries` shape
     * @param  list<array{payment_method_id: int, name: string, is_cash_count: bool, expected_amount: string, payment_count: int, refund_amount: string, change_amount: string}>  $paymentTotals
     */
    public function __construct(
        public int $sessionId,
        public ?string $sessionName,
        public string $configName,
        public ?string $openedAt,
        public string $printedAt,
        public ?string $cashierName,
        public int $orderCount,
        public string $salesTotal,
        public string $taxTotal,
        public string $refundTotal,
        public string $openingBalance,
        public string $cashIn,
        public string $cashOut,
        public string $expectedCash,
        public array $salesRows,
        public array $taxRows,
        public array $paymentTotals,
    ) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'session_id' => $this->sessionId,
            'session_name' => $this->sessionName,
            'config_name' => $this->configName,
            'opened_at' => $this->openedAt,
            'printed_at' => $this->printedAt,
            'cashier_name' => $this->cashierName,
            'order_count' => $this->orderCount,
            'sales_total' => $this->salesTotal,
            'tax_total' => $this->taxTotal,
            'refund_total' => $this->refundTotal,
            'opening_balance' => $this->openingBalance,
            'cash_in' => $this->cashIn,
            'cash_out' => $this->cashOut,
            'expected_cash' => $this->expectedCash,
            'sales' => $this->salesRows,
            'taxes' => $this->taxRows,
            'payment_totals' => $this->paymentTotals,
        ];
    }
}
