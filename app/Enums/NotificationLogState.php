<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Delivery state of a `notification_logs` row.
 */
enum NotificationLogState: string
{
    use HasEnumHelpers;

    case Queued = 'queued';
    case Sent = 'sent';
    case Failed = 'failed';
    case Bounced = 'bounced';

    public function label(): string
    {
        return match ($this) {
            self::Queued => 'Queued',
            self::Sent => 'Sent',
            self::Failed => 'Failed',
            self::Bounced => 'Bounced',
        };
    }
}
