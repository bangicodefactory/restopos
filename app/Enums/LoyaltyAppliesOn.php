<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Which order a program rewards.
 */
enum LoyaltyAppliesOn: string
{
    use HasEnumHelpers;

    case Current = 'current';
    case Future = 'future';
    case Both = 'both';

    public function label(): string
    {
        return match ($this) {
            self::Current => 'Current order',
            self::Future => 'Future orders',
            self::Both => 'Current and future orders',
        };
    }
}
