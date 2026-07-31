<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrepStageType;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One column / lane of a display: "To do" → "Cooking" → "Ready" (spec §2.H).
 *
 * `stage_type` carries the semantics the automation keys on; `sequence` is the
 * left-to-right order and is unique per display.
 */
class PrepStage extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'prep_stages';

    /** @var list<string> */
    protected $fillable = [
        'prep_display_id',
        'name',
        'stage_type',
        'color',
        'alert_after_minutes',
        'sequence',
        'is_default',
    ];

    protected function casts(): array
    {
        return [
            'stage_type' => PrepStageType::class,
            'alert_after_minutes' => 'integer',
            'sequence' => 'integer',
            'is_default' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<PrepDisplay, $this> */
    public function display(): BelongsTo
    {
        return $this->belongsTo(PrepDisplay::class, 'prep_display_id');
    }

    /** @return HasMany<PrepOrderLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(PrepOrderLine::class, 'prep_stage_id');
    }

    /** @return HasMany<PrepLineStageLog, $this> */
    public function logsOut(): HasMany
    {
        return $this->hasMany(PrepLineStageLog::class, 'from_stage_id');
    }

    /** @return HasMany<PrepLineStageLog, $this> */
    public function logsIn(): HasMany
    {
        return $this->hasMany(PrepLineStageLog::class, 'to_stage_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForDisplay(Builder $query, PrepDisplay|int $display): Builder
    {
        return $query->where('prep_display_id', $display instanceof PrepDisplay ? $display->getKey() : $display);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, PrepStageType $type): Builder
    {
        return $query->where('stage_type', $type->value);
    }

    /** The landing stage for newly fired lines. @param  Builder<static>  $query */
    public function scopeDefault(Builder $query): Builder
    {
        return $query->where('is_default', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('sequence')->orderBy('id');
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): stages of the config's displays. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('prep_display_id', PrepDisplay::posLoadScope($config, $profile)->select('prep_displays.id'))
            ->ordered();
    }
}
