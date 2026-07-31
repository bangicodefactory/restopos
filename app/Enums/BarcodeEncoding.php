<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Encoding a `barcode_rules` row applies to.
 */
enum BarcodeEncoding: string
{
    use HasEnumHelpers;

    case Any = 'any';
    case Ean13 = 'ean13';
    case Ean8 = 'ean8';
    case Upca = 'upca';
    case Gs1128 = 'gs1_128';

    public function label(): string
    {
        return match ($this) {
            self::Any => 'Any',
            self::Ean13 => 'EAN-13',
            self::Ean8 => 'EAN-8',
            self::Upca => 'UPC-A',
            self::Gs1128 => 'GS1-128',
        };
    }
}
