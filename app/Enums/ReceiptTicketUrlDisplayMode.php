<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How the receipt portal link is printed on the ticket.
 */
enum ReceiptTicketUrlDisplayMode: string
{
    use HasEnumHelpers;

    case QrCode = 'qr_code';
    case Url = 'url';
    case QrCodeAndUrl = 'qr_code_and_url';

    public function label(): string
    {
        return match ($this) {
            self::QrCode => 'QR code',
            self::Url => 'URL',
            self::QrCodeAndUrl => 'QR code and URL',
        };
    }
}
