<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * UPC ↔ EAN conversion policy of a `barcode_nomenclatures` row.
 */
enum UpcEanConversion: string
{
    use HasEnumHelpers;

    case None = 'none';
    case Ean2Upc = 'ean2upc';
    case Upc2Ean = 'upc2ean';
    case Always = 'always';

    public function label(): string
    {
        return match ($this) {
            self::None => 'Never',
            self::Ean2Upc => 'EAN-13 to UPC-A',
            self::Upc2Ean => 'UPC-A to EAN-13',
            self::Always => 'Always',
        };
    }
}
