<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Bank-QR payload standard used by a `payment_methods` row.
 */
enum QrCodeMethod: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Emv = 'emv';
    case Sepa = 'sepa';
    case Swiss = 'swiss';
    case Pix = 'pix';
    case Upi = 'upi';
    case Promptpay = 'promptpay';

    public function label(): string
    {
        return match ($this) {
            self::None => 'None',
            self::Emv => 'EMVCo',
            self::Sepa => 'SEPA credit transfer',
            self::Swiss => 'Swiss QR-bill',
            self::Pix => 'Pix',
            self::Upi => 'UPI',
            self::Promptpay => 'PromptPay',
        };
    }
}
