<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * How a sync conflict was resolved.
 */
enum SyncResolution: string
{
    use HasEnumHelpers;

    case ServerWins = 'server_wins';
    case ClientWins = 'client_wins';
    case Merged = 'merged';
    case Rerouted = 'rerouted';
    case Rejected = 'rejected';

    public function label(): string
    {
        return match ($this) {
            self::ServerWins => 'Server wins',
            self::ClientWins => 'Client wins',
            self::Merged => 'Merged',
            self::Rerouted => 'Rerouted',
            self::Rejected => 'Rejected',
        };
    }
}
