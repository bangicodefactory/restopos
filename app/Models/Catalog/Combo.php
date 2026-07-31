<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A choice group inside a meal ("Pick a drink") — spec §2.B.
 *
 * `qty_free` picks are included in the meal price; extra picks add their
 * `combo_items.extra_price`. The free-quota price distribution is proportional
 * to `base_price` and is always computed server-side.
 */
class Combo extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'combos';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'base_price' => 'decimal:4',
            'qty_free' => 'integer',
            'qty_max' => 'integer',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<ComboItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(ComboItem::class)->orderBy('sequence');
    }

    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'combo_product')->withPivot('sequence');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->whereHas('products', fn (Builder $q) => $q->whereIn(
                'products.id',
                Product::posLoadScope($config, $profile)->select('id'),
            ));
    }
}
