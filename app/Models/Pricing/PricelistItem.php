<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Enums\PricelistAppliedOn;
use App\Enums\PricelistBase;
use App\Enums\PricelistComputePrice;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One pricing rule, at full Odoo fidelity so the client can price offline
 * (spec §2.C).
 *
 * Resolution contract (server and client must agree): filter by date window and
 * `min_quantity`, then take the first match in specificity order
 * variant → product → pos_category (nearest ancestor first) → global,
 * tie-broken by `sequence, id`.
 */
class PricelistItem extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pricelist_items';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'applied_on' => PricelistAppliedOn::class,
            'compute_price' => PricelistComputePrice::class,
            'base' => PricelistBase::class,
            'min_quantity' => 'decimal:3',
            'date_start' => 'datetime',
            'date_end' => 'datetime',
            'fixed_price' => 'decimal:4',
            'percent_price' => 'decimal:4',
            'price_discount' => 'decimal:4',
            'price_surcharge' => 'decimal:4',
            'price_round' => 'decimal:6',
            'price_min_margin' => 'decimal:4',
            'price_max_margin' => 'decimal:4',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Pricelist, $this> */
    public function pricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class);
    }

    /** @return BelongsTo<Pricelist, $this> */
    public function basePricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class, 'base_pricelist_id');
    }

    /** @return BelongsTo<ProductVariant, $this> */
    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'product_variant_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @return BelongsTo<PosCategory, $this> */
    public function posCategory(): BelongsTo
    {
        return $this->belongsTo(PosCategory::class);
    }

    /** Rules whose date window covers the given moment. @param Builder<static> $query */
    public function scopeEffectiveAt(Builder $query, ?\DateTimeInterface $moment = null): Builder
    {
        $moment ??= now();

        return $query
            ->where(fn (Builder $q) => $q->whereNull('date_start')->orWhere('date_start', '<=', $moment))
            ->where(fn (Builder $q) => $q->whereNull('date_end')->orWhere('date_end', '>=', $moment));
    }

    /** @param  Builder<static>  $query */
    public function scopeForQuantity(Builder $query, string|float $quantity): Builder
    {
        return $query->where('min_quantity', '<=', $quantity);
    }

    /** @param  Builder<static>  $query */
    public function scopeInResolutionOrder(Builder $query): Builder
    {
        return $query->orderByRaw(
            "CASE applied_on WHEN 'variant' THEN 0 WHEN 'product' THEN 1 WHEN 'pos_category' THEN 2 ELSE 3 END"
        )->orderBy('sequence')->orderBy('id');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('pricelist_id', Pricelist::posLoadScope($config, $profile)->select('id'))
            ->where(fn (Builder $q) => $q->whereNull('date_end')->orWhere('date_end', '>=', now()))
            ->inResolutionOrder();
    }
}
