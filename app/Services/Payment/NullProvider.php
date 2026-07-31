<?php

declare(strict_types=1);

namespace App\Services\Payment;

use App\Enums\PaymentTransactionState;
use App\Services\Payment\Dto\PaymentIntent;
use App\Services\Payment\Dto\PaymentResult;
use Illuminate\Support\Str;

/**
 * The default {@see PaymentProvider}: records intents and confirms them
 * immediately without contacting anyone.
 *
 * It exists so the entire self-order payment path — intent, redirect handling,
 * confirmation, `payment_transactions` bookkeeping, `pos_payments` creation and
 * the `payment.status` broadcast — is exercised end to end in tests and in
 * demos. Swapping in a real PSP is one binding in `AppServiceProvider`.
 *
 * It deliberately refuses webhooks: an unsigned webhook must never be able to
 * move money.
 */
final readonly class NullProvider implements PaymentProvider
{
    public function code(): string
    {
        return 'null';
    }

    public function createIntent(PaymentIntent $intent): PaymentResult
    {
        return new PaymentResult(
            state: PaymentTransactionState::Pending,
            providerReference: $intent->reference ?? ('null_'.Str::lower(Str::random(24))),
            amount: $intent->amount,
            redirectUrl: $intent->returnUrl,
            message: 'Stub provider — call confirm() to settle.',
            payload: ['provider' => 'null', 'order_uuid' => $intent->orderUuid],
        );
    }

    /** @param array<string, mixed> $payload */
    public function confirm(string $providerReference, array $payload = []): PaymentResult
    {
        return new PaymentResult(
            state: PaymentTransactionState::Done,
            providerReference: $providerReference,
            amount: (string) ($payload['amount'] ?? '0'),
            message: 'Confirmed by the stub provider.',
            payload: $payload,
        );
    }

    public function cancel(string $providerReference): PaymentResult
    {
        return new PaymentResult(
            state: PaymentTransactionState::Cancelled,
            providerReference: $providerReference,
            amount: '0',
            message: 'Cancelled by the stub provider.',
        );
    }

    /** @param array<string, string> $headers */
    public function verifyWebhook(string $rawBody, array $headers): bool
    {
        return false;
    }
}
