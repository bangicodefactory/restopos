<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Activation state of a `payment_providers` row.
 */
enum PaymentProviderState: string
{
    use HasEnumHelpers;

    case Disabled = 'disabled';
    case Test = 'test';
    case Enabled = 'enabled';

    public function label(): string
    {
        return match ($this) {
            self::Disabled => 'Disabled',
            self::Test => 'Test mode',
            self::Enabled => 'Enabled',
        };
    }

    public function isUsable(): bool
    {
        return $this !== self::Disabled;
    }
}
