<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Role of a `customers` row inside its parent/child pair.
 */
enum AddressType: string
{
    use HasEnumHelpers;

    case Contact = 'contact';
    case Invoice = 'invoice';
    case Delivery = 'delivery';
    case Other = 'other';

    public function label(): string
    {
        return match ($this) {
            self::Contact => 'Contact',
            self::Invoice => 'Invoice address',
            self::Delivery => 'Delivery address',
            self::Other => 'Other address',
        };
    }
}
