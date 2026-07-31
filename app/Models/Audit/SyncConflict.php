<?php

declare(strict_types=1);

namespace App\Models\Audit;

use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use App\Models\Concerns\HasUuid;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Anything the sync layer had to resolve or reject — the ops queue (spec §2.K).
 *
 * One bad order never blocks the rest of the queue (docs/CONVENTIONS.md); it
 * lands here instead, with `record_uuid` identifying the offending record and
 * `resolution` recording what the server did about it. Never sent to any client.
 */
class SyncConflict extends Model
{
    use HasUuid;

    protected $table = 'sync_conflicts';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_config_id',
        'pos_device_id',
        'conflict_type',
        'model_type',
        'record_uuid',
        'resolution',
        'detail',
        'detected_at',
        'resolved_by_user_id',
        'acknowledged_at',
    ];

    protected function casts(): array
    {
        return [
            'conflict_type' => SyncConflictType::class,
            'resolution' => SyncResolution::class,
            'detail' => AsArrayObject::class,
            'detected_at' => 'datetime',
            'acknowledged_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    /** @return BelongsTo<User, $this> */
    public function resolvedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'resolved_by_user_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, SyncConflictType $type): Builder
    {
        return $query->where('conflict_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeResolvedAs(Builder $query, SyncResolution $resolution): Builder
    {
        return $query->where('resolution', $resolution->value);
    }

    /** The ops queue proper. @param  Builder<static>  $query */
    public function scopeUnacknowledged(Builder $query): Builder
    {
        return $query->whereNull('acknowledged_at')->orderByDesc('detected_at');
    }

    /** @param  Builder<static>  $query */
    public function scopeForRecord(Builder $query, string $recordUuid): Builder
    {
        return $query->where('record_uuid', $recordUuid);
    }

    public function isRejected(): bool
    {
        return $this->resolution === SyncResolution::Rejected;
    }
}
