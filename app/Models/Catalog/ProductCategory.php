<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Internal/reporting category tree used for sales grouping (spec §2.B). */
class ProductCategory extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'product_categories';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['sequence' => 'integer'];
    }

    /** @return BelongsTo<ProductCategory, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    /** @return HasMany<ProductCategory, $this> */
    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }

    /** @return HasMany<Product, $this> */
    public function products(): HasMany
    {
        return $this->hasMany(Product::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeDescendantsOf(Builder $query, self $category): Builder
    {
        return $query->where('path', 'like', $category->path.'%');
    }
}
