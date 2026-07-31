<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\DayPeriod;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Opening hours of a preset (replaces `resource.calendar.attendance`) — spec §2.D. */
class PresetServiceWindow extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'preset_service_windows';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'day_of_week' => 'integer',
            'hour_from' => 'decimal:2',
            'hour_to' => 'decimal:2',
            'day_period' => DayPeriod::class,
        ];
    }

    /** @return BelongsTo<PosPreset, $this> */
    public function preset(): BelongsTo
    {
        return $this->belongsTo(PosPreset::class, 'pos_preset_id');
    }

    /** 0 = Monday … 6 = Sunday. @param Builder<static> $query */
    public function scopeOnDay(Builder $query, int $dayOfWeek): Builder
    {
        return $query->where('day_of_week', $dayOfWeek);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('pos_preset_id', PosPreset::posLoadScope($config, $profile)->select('id'));
    }
}
