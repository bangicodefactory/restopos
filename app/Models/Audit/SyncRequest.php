<?php

declare(strict_types=1);

namespace App\Models\Audit;

use App\Models\Concerns\HasUuid;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Request-level idempotency + replay protection for the offline queue
 * (spec §2.K).
 *
 * The device sends a `request_uuid` per batch; replaying the same batch returns
 * the stored `response_body` instead of re-applying it. `payload_hash` catches
 * the pathological case of the same uuid carrying different content.
 * Never sent to any client (spec §5.4).
 */
class SyncRequest extends Model
{
    use HasUuid;

    protected $table = 'sync_requests';

    /** @var list<string> */
    protected $fillable = [
        'request_uuid',
        'pos_device_id',
        'pos_config_id',
        'endpoint',
        'payload_hash',
        'record_uuids',
        'response_status',
        'response_body',
        'processed_at',
        'duration_ms',
    ];

    protected function casts(): array
    {
        return [
            'record_uuids' => AsArrayObject::class,
            'response_status' => 'integer',
            'response_body' => AsArrayObject::class,
            'processed_at' => 'datetime',
            'duration_ms' => 'integer',
        ];
    }

    /** This table keys its idempotency token as `request_uuid`, not `uuid`. */
    public function uuidColumn(): string
    {
        return 'request_uuid';
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeForEndpoint(Builder $query, string $endpoint): Builder
    {
        return $query->where('endpoint', $endpoint);
    }

    /** Batches accepted and already applied — a replay must be short-circuited. */
    /** @param  Builder<static>  $query */
    public function scopeProcessed(Builder $query): Builder
    {
        return $query->whereNotNull('processed_at');
    }

    /** @param  Builder<static>  $query */
    public function scopeUnprocessed(Builder $query): Builder
    {
        return $query->whereNull('processed_at');
    }

    public function isReplayOf(string $payloadHash): bool
    {
        return $this->payload_hash === $payloadHash;
    }
}
