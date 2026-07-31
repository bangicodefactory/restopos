<?php

declare(strict_types=1);

namespace App\Services\Pos\Dto;

/**
 * Everything the closing popup needs in one shot (spec 01-schema §5.4).
 */
final readonly class SessionClosingData
{
    /**
     * @param  list<array{payment_method_id: int, name: string, is_cash_count: bool, expected_amount: string, payment_count: int, refund_amount: string, change_amount: string}>  $paymentTotals
     */
    public function __construct(
        public int $sessionId,
        public string $openingBalance,
        public string $cashIn,
        public string $cashOut,
        public string $expectedCash,
        public array $paymentTotals,
        public int $orderCount,
        public int $draftOrderCount,
        public string $amountAuthorizedDiff,
        public bool $enforcesMaximumDifference,
    ) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'session_id' => $this->sessionId,
            'opening_balance' => $this->openingBalance,
            'cash_in' => $this->cashIn,
            'cash_out' => $this->cashOut,
            'expected_cash' => $this->expectedCash,
            'payment_totals' => $this->paymentTotals,
            'order_count' => $this->orderCount,
            'draft_order_count' => $this->draftOrderCount,
            'amount_authorized_diff' => $this->amountAuthorizedDiff,
            'enforces_maximum_difference' => $this->enforcesMaximumDifference,
        ];
    }
}
