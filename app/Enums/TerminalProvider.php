<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Integrated card-terminal vendor of a `payment_methods` row.
 */
enum TerminalProvider: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Adyen = 'adyen';
    case Stripe = 'stripe';
    case Viva = 'viva';
    case Razorpay = 'razorpay';
    case MercadoPago = 'mercado_pago';
    case PineLabs = 'pine_labs';
    case Qfpay = 'qfpay';
    case Six = 'six';
    case Other = 'other';

    public function label(): string
    {
        return match ($this) {
            self::None => 'No terminal',
            self::Adyen => 'Adyen',
            self::Stripe => 'Stripe',
            self::Viva => 'Viva Wallet',
            self::Razorpay => 'Razorpay',
            self::MercadoPago => 'Mercado Pago',
            self::PineLabs => 'Pine Labs',
            self::Qfpay => 'QFPay',
            self::Six => 'SIX',
            self::Other => 'Other',
        };
    }

    public function isIntegrated(): bool
    {
        return $this !== self::None;
    }
}
