<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A price list; must share the register's currency to be usable on it (spec §2.C). */
class Pricelist extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'pricelists';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<PricelistItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(PricelistItem::class);
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_pricelist');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where(fn (Builder $q) => $q
                ->whereKey($config->pricelist_id)
                ->orWhereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey())));
    }
}
