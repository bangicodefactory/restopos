<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrepDisplayLayout;
use App\Models\Catalog\PosCategory;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Str;

/**
 * A kitchen or bar screen (spec §2.H).
 *
 * `access_token` doubles as the broadcast channel name (`prep-display.{token}`)
 * and as the unauthenticated screen URL, exactly like `pos_configs.access_token`
 * does for a register. Routing is by frozen POS category, or everything when
 * `show_all_categories` is set.
 */
class PrepDisplay extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'prep_displays';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'name',
        'access_token',
        'layout',
        'auto_advance_on_all_ready',
        'show_all_categories',
        'average_prep_minutes',
        'late_threshold_minutes',
        'done_retention_minutes',
        'sound_on_new_order',
        'active',
    ];

    protected $hidden = ['access_token'];

    protected function casts(): array
    {
        return [
            'layout' => PrepDisplayLayout::class,
            'auto_advance_on_all_ready' => 'boolean',
            'show_all_categories' => 'boolean',
            'average_prep_minutes' => 'integer',
            'late_threshold_minutes' => 'integer',
            'done_retention_minutes' => 'integer',
            'sound_on_new_order' => 'boolean',
            'active' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return HasMany<PrepStage, $this> */
    public function stages(): HasMany
    {
        return $this->hasMany(PrepStage::class, 'prep_display_id')->orderBy('sequence');
    }

    /** @return HasMany<PrepOrder, $this> */
    public function prepOrders(): HasMany
    {
        return $this->hasMany(PrepOrder::class, 'prep_display_id');
    }

    /** Routing categories. @return BelongsToMany<PosCategory, $this> */
    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'pos_category_prep_display', 'prep_display_id', 'pos_category_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_prep_display', 'prep_display_id', 'pos_config_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        $id = $config instanceof PosConfig ? $config->getKey() : $config;

        return $query->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($id));
    }

    // ----------------------------------------------------------------- helpers

    /** Routing: everything, or only the frozen categories of the line. */
    public function handlesCategory(?int $posCategoryId): bool
    {
        if ($this->show_all_categories) {
            return true;
        }

        return $posCategoryId !== null && $this->categories->contains('id', $posCategoryId);
    }

    /** Broadcast channel name for this screen (spec §6.6). */
    public function channelName(): string
    {
        return 'prep-display.'.$this->access_token;
    }

    public static function newAccessToken(): string
    {
        return Str::lower(Str::random(32));
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): via `pos_config_prep_display`, active only. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->forConfig($config)
            ->active();
    }
}
