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
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/**
 * The per-template instance of an attribute value, carrying the price extra.
 * This is Odoo's `product.template.attribute.value` — the id order lines
 * actually reference (spec §2.B).
 */
class ProductAttributeLineValue extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'product_attribute_line_values';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'price_extra' => 'decimal:4',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<ProductAttributeLine, $this> */
    public function line(): BelongsTo
    {
        return $this->belongsTo(ProductAttributeLine::class, 'product_attribute_line_id');
    }

    /** @return BelongsTo<ProductAttributeValue, $this> */
    public function value(): BelongsTo
    {
        return $this->belongsTo(ProductAttributeValue::class, 'product_attribute_value_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @return BelongsToMany<ProductVariant, $this> */
    public function variants(): BelongsToMany
    {
        return $this->belongsToMany(
            ProductVariant::class,
            'product_variant_attribute_value',
            'product_attribute_line_value_id',
            'product_variant_id',
        );
    }

    /** @return BelongsToMany<ProductAttributeLineValue, $this> */
    public function exclusions(): BelongsToMany
    {
        return $this->belongsToMany(
            self::class,
            'product_attribute_exclusions',
            'product_attribute_line_value_id',
            'excluded_value_id',
        );
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('product_id', Product::posLoadScope($config, $profile)->select('id'));
    }
}
