<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * What sends a `loyalty_communications` message.
 */
enum LoyaltyCommunicationTrigger: string
{
    use HasEnumHelpers;

    case Create = 'create';
    case PointsReach = 'points_reach';
    case ExpirySoon = 'expiry_soon';

    public function label(): string
    {
        return match ($this) {
            self::Create => 'On card creation',
            self::PointsReach => 'When points reach a threshold',
            self::ExpirySoon => 'Before expiry',
        };
    }
}
