<?php

declare(strict_types=1);

namespace App\Models\Restaurant;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * A room / area of the restaurant holding a table map (spec §2.G).
 *
 * Floors can be created and rearranged from the register's floor-edit mode, so
 * they carry a client-minted `uuid`. `table_count` is denormalised for the
 * floor tab badge.
 */
class Floor extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'restaurant_floors';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'name',
        'background_color',
        'background_media_id',
        'sequence',
        'table_count',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'sequence' => 'integer',
            'table_count' => 'integer',
            'active' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return HasMany<Table, $this> */
    public function tables(): HasMany
    {
        return $this->hasMany(Table::class, 'restaurant_floor_id')->orderBy('table_number');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function backgroundImage(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'background_media_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_floor', 'restaurant_floor_id', 'pos_config_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        $id = $config instanceof PosConfig ? $config->getKey() : $config;

        return $query->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($id));
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('sequence')->orderBy('id');
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): via `pos_config_floor`, active only. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->forConfig($config)
            ->active()
            ->ordered();
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            return ['id', 'uuid', 'name', 'sequence', 'updated_at'];
        }

        return ['*'];
    }
}
