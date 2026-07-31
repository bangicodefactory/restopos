<?php

declare(strict_types=1);

namespace App\Services\Payment\Dto;

use App\Enums\PaymentTransactionState;

/** A provider's answer, normalised. */
final readonly class PaymentResult
{
    /** @param array<string, mixed> $payload */
    public function __construct(
        public PaymentTransactionState $state,
        public string $providerReference,
        public string $amount,
        public ?string $redirectUrl = null,
        public ?string $message = null,
        public array $payload = [],
    ) {}

    public function isCaptured(): bool
    {
        return $this->state === PaymentTransactionState::Done;
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'state' => $this->state->value,
            'provider_reference' => $this->providerReference,
            'amount' => $this->amount,
            'redirect_url' => $this->redirectUrl,
            'message' => $this->message,
            'payload' => $this->payload,
        ];
    }
}
