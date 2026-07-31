<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Models\Pos\Payment as OrderPayment;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin OrderPayment */
final class OrderPaymentResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var OrderPayment $payment */
        $payment = $this->resource;

        return [
            'id' => (int) $payment->getKey(),
            'uuid' => (string) $payment->uuid,
            'pos_order_id' => (int) $payment->pos_order_id,
            'payment_method_id' => (int) $payment->payment_method_id,
            'amount' => (string) $payment->amount,
            'is_change' => (bool) $payment->is_change,
            'is_refund' => (bool) $payment->is_refund,
            'label' => $payment->label,
            'paid_at' => $payment->paid_at,
            'payment_status' => (string) ($payment->payment_status?->value ?? $payment->payment_status),
            // Terminal metadata only — never a PAN.
            'card_brand' => $payment->card_brand,
            'card_last4' => $payment->card_last4,
            'auth_code' => $payment->auth_code,
            'transaction_reference' => $payment->transaction_reference,
        ];
    }
}
