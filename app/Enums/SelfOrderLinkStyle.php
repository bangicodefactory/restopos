<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Button style of a `self_order_custom_links` row.
 */
enum SelfOrderLinkStyle: string
{
    use HasEnumHelpers;

    case Primary = 'primary';
    case Secondary = 'secondary';
    case Success = 'success';
    case Danger = 'danger';
    case Warning = 'warning';
    case Info = 'info';
    case Light = 'light';
    case Dark = 'dark';

    public function label(): string
    {
        return match ($this) {
            self::Primary => 'Primary',
            self::Secondary => 'Secondary',
            self::Success => 'Success',
            self::Danger => 'Danger',
            self::Warning => 'Warning',
            self::Info => 'Info',
            self::Light => 'Light',
            self::Dark => 'Dark',
        };
    }
}
