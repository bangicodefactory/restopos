<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Why the sync layer had to intervene (`sync_conflicts.conflict_type`).
 */
enum SyncConflictType: string
{
    use HasEnumHelpers;

    case StaleWrite = 'stale_write';
    case DuplicateTableOrder = 'duplicate_table_order';
    case ClosedSession = 'closed_session';
    case UuidCollision = 'uuid_collision';
    case PrepSnapshotStale = 'prep_snapshot_stale';
    case PayloadMismatch = 'payload_mismatch';
    case PriceTamper = 'price_tamper';

    public function label(): string
    {
        return match ($this) {
            self::StaleWrite => 'Stale write',
            self::DuplicateTableOrder => 'Duplicate table order',
            self::ClosedSession => 'Closed session',
            self::UuidCollision => 'UUID collision',
            self::PrepSnapshotStale => 'Outdated preparation snapshot',
            self::PayloadMismatch => 'Payload mismatch',
            self::PriceTamper => 'Price tampering',
        };
    }
}
