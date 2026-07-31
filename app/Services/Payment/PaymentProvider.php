<?php

declare(strict_types=1);

namespace App\Services\Payment;

use App\Services\Payment\Dto\PaymentIntent;
use App\Services\Payment\Dto\PaymentResult;

/**
 * The online-payment seam (spec 02 SLF-060…SLF-079).
 *
 * Self-order and kiosk payments go through a provider; the register's card
 * terminals do not (those are a client-side driver reporting a result the
 * server then records). Keeping this an interface means the whole self-order
 * payment flow is testable and shippable against {@see NullProvider} before a
 * real PSP is chosen — and swapping the PSP later touches one class.
 *
 * The **server** is authoritative for capture: a client may report a result but
 * the accounting payment exists only when `confirm()` says so (spec 03 §3.7).
 */
interface PaymentProvider
{
    /** Stable slug, matched against `payment_providers.code`. */
    public function code(): string;

    /**
     * Start a payment. Returns the redirect/checkout material the customer's
     * browser needs plus the provider reference we will reconcile against.
     */
    public function createIntent(PaymentIntent $intent): PaymentResult;

    /**
     * Confirm/capture. Called by the client's return URL **and** by the webhook;
     * it must be idempotent on `providerReference`.
     */
    public function confirm(string $providerReference, array $payload = []): PaymentResult;

    /** Cancel a pending intent. */
    public function cancel(string $providerReference): PaymentResult;

    /**
     * Verify a webhook payload's authenticity before it is allowed to move
     * money. A provider without signatures returns false and the webhook route
     * stays disabled.
     *
     * @param  array<string, string>  $headers
     */
    public function verifyWebhook(string $rawBody, array $headers): bool;
}
