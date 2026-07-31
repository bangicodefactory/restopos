<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Transport used to reach a `pos_printers` row.
 */
enum PrinterType: string
{
    use HasEnumHelpers;

    case Iot = 'iot';
    case EpsonEpos = 'epson_epos';
    case NetworkEscpos = 'network_escpos';
    case Browser = 'browser';

    public function label(): string
    {
        return match ($this) {
            self::Iot => 'IoT box',
            self::EpsonEpos => 'Epson ePOS',
            self::NetworkEscpos => 'Network ESC/POS',
            self::Browser => 'Browser print',
        };
    }

    public function requiresIp(): bool
    {
        return $this === self::EpsonEpos || $this === self::NetworkEscpos;
    }
}
