<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** "If value A is chosen, value B is impossible" (spec §2.B). */
class ProductAttributeExclusion extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'product_attribute_exclusions';

    protected $guarded = [];

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @return BelongsTo<ProductAttributeLineValue, $this> */
    public function value(): BelongsTo
    {
        return $this->belongsTo(ProductAttributeLineValue::class, 'product_attribute_line_value_id');
    }

    /** @return BelongsTo<ProductAttributeLineValue, $this> */
    public function excludedValue(): BelongsTo
    {
        return $this->belongsTo(ProductAttributeLineValue::class, 'excluded_value_id');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('product_id', Product::posLoadScope($config, $profile)->select('id'));
    }
}
