<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** "This template uses attribute X with these values" (spec §2.B). */
class ProductAttributeLine extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'product_attribute_lines';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'is_required' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @return BelongsTo<ProductAttribute, $this> */
    public function attribute(): BelongsTo
    {
        return $this->belongsTo(ProductAttribute::class, 'product_attribute_id');
    }

    /** @return HasMany<ProductAttributeLineValue, $this> */
    public function lineValues(): HasMany
    {
        return $this->hasMany(ProductAttributeLineValue::class)->orderBy('sequence');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('product_id', Product::posLoadScope($config, $profile)->select('id'));
    }
}
