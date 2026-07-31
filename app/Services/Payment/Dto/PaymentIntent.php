<?php

declare(strict_types=1);

namespace App\Services\Payment\Dto;

/** Everything a provider needs to start a customer payment. */
final readonly class PaymentIntent
{
    public function __construct(
        public string $orderUuid,
        public string $orderAccessToken,
        public string $amount,
        public string $currencyCode,
        public int $paymentMethodId,
        public ?string $customerEmail = null,
        public ?string $customerPhone = null,
        public ?string $returnUrl = null,
        public ?string $reference = null,
    ) {}
}
