<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What a `preparation_print_jobs` row prints.
 */
enum PrintJobType: string
{
    use HasEnumHelpers;

    case PrepNew = 'prep_new';
    case PrepCancelled = 'prep_cancelled';
    case PrepNoteUpdate = 'prep_note_update';
    case PrepFireCourse = 'prep_fire_course';
    case Bill = 'bill';
    case Receipt = 'receipt';
    case TipSlip = 'tip_slip';
    case CashReport = 'cash_report';
    case Test = 'test';

    public function label(): string
    {
        return match ($this) {
            self::PrepNew => 'Kitchen ticket',
            self::PrepCancelled => 'Cancellation ticket',
            self::PrepNoteUpdate => 'Note update ticket',
            self::PrepFireCourse => 'Fire course ticket',
            self::Bill => 'Pro-forma bill',
            self::Receipt => 'Customer receipt',
            self::TipSlip => 'Tip slip',
            self::CashReport => 'Cash report',
            self::Test => 'Test print',
        };
    }

    public function isPreparation(): bool
    {
        return match ($this) {
            self::PrepNew, self::PrepCancelled, self::PrepNoteUpdate, self::PrepFireCourse => true,
            default => false,
        };
    }
}
