<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** Merchandising tag shown on the self-order menu ("Spicy", "Vegan") — spec §2.B. */
class ProductTag extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'product_tags';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'color' => 'integer',
            'visible_to_customers' => 'boolean',
            'sequence' => 'integer',
        ];
    }

    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'product_tag_product');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeVisibleToCustomers(Builder $query): Builder
    {
        return $query->where('visible_to_customers', true);
    }
}
