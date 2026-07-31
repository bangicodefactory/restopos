<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a scanned barcode means once decoded (spec §4.10).
 */
enum BarcodeRuleType: string
{
    use HasEnumHelpers;

    case Product = 'product';
    case Weight = 'weight';
    case Price = 'price';
    case Discount = 'discount';
    case Customer = 'customer';
    case Cashier = 'cashier';
    case Coupon = 'coupon';
    case Lot = 'lot';
    case Package = 'package';
    case Alias = 'alias';

    public function label(): string
    {
        return match ($this) {
            self::Product => 'Product',
            self::Weight => 'Weighted product',
            self::Price => 'Priced product',
            self::Discount => 'Discounted product',
            self::Customer => 'Customer badge',
            self::Cashier => 'Cashier badge',
            self::Coupon => 'Coupon / loyalty code',
            self::Lot => 'Lot number',
            self::Package => 'Package',
            self::Alias => 'Alias',
        };
    }

    /** Rules whose pattern embeds a numeric value ({NNDDD}). */
    public function hasEmbeddedValue(): bool
    {
        return match ($this) {
            self::Weight, self::Price, self::Discount => true,
            default => false,
        };
    }
}
