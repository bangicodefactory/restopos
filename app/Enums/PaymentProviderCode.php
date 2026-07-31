<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Supported online payment gateways (`payment_providers.code`).
 */
enum PaymentProviderCode: string
{
    use HasEnumHelpers;

    case Stripe = 'stripe';
    case Adyen = 'adyen';
    case Paypal = 'paypal';
    case Mollie = 'mollie';
    case Razorpay = 'razorpay';
    case Flutterwave = 'flutterwave';
    case Aps = 'aps';
    case Custom = 'custom';

    public function label(): string
    {
        return match ($this) {
            self::Stripe => 'Stripe',
            self::Adyen => 'Adyen',
            self::Paypal => 'PayPal',
            self::Mollie => 'Mollie',
            self::Razorpay => 'Razorpay',
            self::Flutterwave => 'Flutterwave',
            self::Aps => 'Amazon Payment Services',
            self::Custom => 'Custom',
        };
    }

    /** Providers that cannot process a payment without a customer e-mail. */
    public function requiresCustomerEmail(): bool
    {
        return $this === self::Aps || $this === self::Flutterwave;
    }
}
