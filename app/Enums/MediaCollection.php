<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Logical bucket a `media_files` row belongs to (spec §4.14).
 */
enum MediaCollection: string
{
    use HasEnumHelpers;

    case Image = 'image';
    case SelfHome = 'self_home';
    case SelfBackground = 'self_background';
    case Brand = 'brand';
    case FloorBackground = 'floor_background';
    case ReceiptLogo = 'receipt_logo';
    case Avatar = 'avatar';
    /** Generated, non-image artefacts — the accounting export file and anything like it. */
    case Document = 'document';

    public function label(): string
    {
        return match ($this) {
            self::Image => 'Image',
            self::SelfHome => 'Self-order home',
            self::SelfBackground => 'Self-order background',
            self::Brand => 'Brand',
            self::FloorBackground => 'Floor background',
            self::ReceiptLogo => 'Receipt logo',
            self::Avatar => 'Avatar',
            self::Document => 'Document',
        };
    }
}
