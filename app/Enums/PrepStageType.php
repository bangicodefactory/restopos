<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Semantics of a KDS column (`prep_stages.stage_type`, spec §4.3).
 */
enum PrepStageType: string
{
    use HasEnumHelpers;

    case Todo = 'todo';
    case InProgress = 'in_progress';
    case Ready = 'ready';
    case Done = 'done';

    public function label(): string
    {
        return match ($this) {
            self::Todo => 'To do',
            self::InProgress => 'Cooking',
            self::Ready => 'Ready',
            self::Done => 'Served',
        };
    }

    public function toLineState(): PrepLineState
    {
        return match ($this) {
            self::Todo => PrepLineState::Todo,
            self::InProgress => PrepLineState::InProgress,
            self::Ready => PrepLineState::Ready,
            self::Done => PrepLineState::Served,
        };
    }
}
