<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Ticket kind produced by the preparation delta engine (spec §4.3).
 */
enum PrepChangeType: string
{
    use HasEnumHelpers;

    case New = 'new';
    case Cancelled = 'cancelled';
    case NoteUpdate = 'note_update';
    case FireCourse = 'fire_course';

    public function label(): string
    {
        return match ($this) {
            self::New => 'New item',
            self::Cancelled => 'Cancellation',
            self::NoteUpdate => 'Note update',
            self::FireCourse => 'Fire course',
        };
    }
}
