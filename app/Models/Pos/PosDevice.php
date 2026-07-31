<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\DeviceType;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Employee;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One physical register / kiosk / customer display attached to a config
 * (spec §2.A). `device_identifier` is the per-config number embedded in
 * `receipt_number`.
 */
class PosDevice extends Model implements PosLoadable
{
    use HasActiveState;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'pos_devices';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'device_identifier' => 'integer',
            'device_type' => DeviceType::class,
            'last_seen_at' => 'datetime',
            'last_synced_at' => 'datetime',
            'has_paper' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class);
    }

    /** @return BelongsTo<Employee, $this> */
    public function currentEmployee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'current_employee_id');
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    public function touchSeen(): void
    {
        $this->forceFill(['last_seen_at' => now()])->save();
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->where('pos_config_id', $config->getKey())->where('active', true);
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return ['id', 'uuid', 'device_identifier', 'name', 'device_type', 'current_employee_id', 'has_paper'];
    }
}
