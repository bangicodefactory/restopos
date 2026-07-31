<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Enums\TaxAmountType;
use App\Enums\TaxRoundingStrategy;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
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

/**
 * A tax definition, kept at full Odoo fidelity (spec §0.9 / §2.C).
 *
 * Evaluation order is `sequence, id`; a tax with `include_base_amount` adds its
 * amount to the running base for subsequent taxes whose `is_base_affected` is
 * true. The maths itself lives in `App\Support\Tax\TaxEngine`, never here.
 */
class Tax extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'taxes';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'amount_type' => TaxAmountType::class,
            'amount' => 'decimal:4',
            'price_include' => 'boolean',
            'include_base_amount' => 'boolean',
            'is_base_affected' => 'boolean',
            'has_negative_factor' => 'boolean',
            'sequence' => 'integer',
            'rounding_strategy' => TaxRoundingStrategy::class,
            'is_used' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<TaxGroup, $this> */
    public function group(): BelongsTo
    {
        return $this->belongsTo(TaxGroup::class, 'tax_group_id');
    }

    /** Composition for `amount_type = group` and compound chains. */
    /** @return BelongsToMany<Tax, $this> */
    public function children(): BelongsToMany
    {
        return $this->belongsToMany(self::class, 'tax_children', 'parent_tax_id', 'child_tax_id')
            ->withPivot('sequence')
            ->orderBy('tax_children.sequence');
    }

    /** @return BelongsToMany<Tax, $this> */
    public function parents(): BelongsToMany
    {
        return $this->belongsToMany(self::class, 'tax_children', 'child_tax_id', 'parent_tax_id');
    }

    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'product_tax');
    }

    /** @return BelongsToMany<ProductVariant, $this> */
    public function productVariants(): BelongsToMany
    {
        return $this->belongsToMany(ProductVariant::class, 'product_variant_tax');
    }

    /** @param  Builder<static>  $query */
    public function scopeInEvaluationOrder(Builder $query): Builder
    {
        return $query->orderBy('sequence')->orderBy('id');
    }

    /** Taxes are loaded archived-included: historical order lines reference them (spec §5.3). */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->where('company_id', $config->company_id)->inEvaluationOrder();
    }
}
