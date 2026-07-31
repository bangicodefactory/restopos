<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Enums\ProductType;
use App\Enums\SpecialKind;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\Tax;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Product template — the sellable concept (spec §2.B).
 *
 * Every product has at least one {@see ProductVariant}; an attribute-less
 * product has exactly one. Prices, taxes and combos hang off the template,
 * barcodes off the variants.
 */
class Product extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'products';

    protected $guarded = [];

    /** @var list<string> */
    protected $appends = ['pos_category_ids', 'tax_ids'];

    protected function casts(): array
    {
        return [
            'product_type' => ProductType::class,
            'special_kind' => SpecialKind::class,
            'list_price' => 'decimal:4',
            'standard_price' => 'decimal:4',
            'available_in_pos' => 'boolean',
            'self_order_available' => 'boolean',
            'to_weight' => 'boolean',
            'track_stock' => 'boolean',
            'allow_negative_stock' => 'boolean',
            'is_special' => 'boolean',
            'color' => 'integer',
            'pos_sequence' => 'integer',
            'is_favorite' => 'boolean',
            'last_sold_at' => 'datetime',
            'sale_count' => 'integer',
            'has_image' => 'boolean',
            'attribute_count' => 'integer',
            'combo_count' => 'integer',
            'sale_ok' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<ProductVariant, $this> */
    public function variants(): HasMany
    {
        return $this->hasMany(ProductVariant::class);
    }

    /** @return BelongsTo<ProductCategory, $this> */
    public function productCategory(): BelongsTo
    {
        return $this->belongsTo(ProductCategory::class);
    }

    /** @return BelongsToMany<PosCategory, $this> */
    public function posCategories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'pos_category_product')
            ->withPivot('sequence')
            ->orderBy('pos_category_product.sequence');
    }

    /**
     * Category ids as a flat array — the shape both the register and self-order catalogs index on
     * (Dexie `*pos_category_ids`, {@see resources/js/register/data/catalog-load.ts} and
     * {@see resources/js/selforder/catalog.ts}). Appended so the generic bootstrap/delta serializer
     * ({@see \App\Services\Pos\BootstrapService}) carries it. Only materialised when `posCategories`
     * is eager-loaded (as `posLoadScope()` does); otherwise `[]`, never an N+1 query.
     *
     * @return list<int>
     */
    public function getPosCategoryIdsAttribute(): array
    {
        return $this->relationLoaded('posCategories')
            ? $this->posCategories->pluck('id')->map(intval(...))->all()
            : [];
    }

    /**
     * Sale-tax ids as a flat array — the register reads this when pricing a line
     * ({@see resources/js/register/data/catalog.ts} `taxIdsFor`). Same relation-appended shape and
     * eager-load guard as {@see self::getPosCategoryIdsAttribute()}.
     *
     * @return list<int>
     */
    public function getTaxIdsAttribute(): array
    {
        return $this->relationLoaded('taxes')
            ? $this->taxes->pluck('id')->map(intval(...))->all()
            : [];
    }

    /** @return BelongsTo<Uom, $this> */
    public function uom(): BelongsTo
    {
        return $this->belongsTo(Uom::class);
    }

    /** @return BelongsToMany<Tax, $this> */
    public function taxes(): BelongsToMany
    {
        return $this->belongsToMany(Tax::class, 'product_tax');
    }

    /** @return BelongsToMany<ProductTag, $this> */
    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(ProductTag::class, 'product_tag_product');
    }

    /** Upsell / cross-sell suggestions. @return BelongsToMany<Product, $this> */
    public function optionalProducts(): BelongsToMany
    {
        return $this->belongsToMany(self::class, 'product_optional_products', 'product_id', 'optional_product_id')
            ->withPivot('sequence');
    }

    /** @return HasMany<ProductAttributeLine, $this> */
    public function attributeLines(): HasMany
    {
        return $this->hasMany(ProductAttributeLine::class)->orderBy('sequence');
    }

    /** @return HasMany<ProductAttributeLineValue, $this> */
    public function attributeLineValues(): HasMany
    {
        return $this->hasMany(ProductAttributeLineValue::class);
    }

    /** @return HasMany<ProductAttributeExclusion, $this> */
    public function attributeExclusions(): HasMany
    {
        return $this->hasMany(ProductAttributeExclusion::class);
    }

    /** The choice groups composing this meal. @return BelongsToMany<Combo, $this> */
    public function combos(): BelongsToMany
    {
        return $this->belongsToMany(Combo::class, 'combo_product')
            ->withPivot('sequence')
            ->orderBy('combo_product.sequence');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeAvailableInPos(Builder $query): Builder
    {
        return $query->where('available_in_pos', true)->where('sale_ok', true)->where('active', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeAvailableInSelfOrder(Builder $query): Builder
    {
        return $query->availableInPos()->where('self_order_available', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeSpecial(Builder $query, ?SpecialKind $kind = null): Builder
    {
        return $query->where('is_special', true)
            ->when($kind !== null, fn (Builder $q) => $q->where('special_kind', $kind->value));
    }

    /** @param  Builder<static>  $query */
    public function scopeInPosCategory(Builder $query, PosCategory|int $category): Builder
    {
        $id = $category instanceof PosCategory ? $category->getKey() : $category;

        return $query->whereHas('posCategories', fn (Builder $q) => $q->whereKey($id));
    }

    /** @param  Builder<static>  $query */
    public function scopeSearch(Builder $query, string $term): Builder
    {
        $like = '%'.$term.'%';

        return $query->where(fn (Builder $q) => $q
            ->where('name', 'like', $like)
            ->orWhere('default_code', 'like', $like)
            ->orWhere('barcode', $term));
    }

    public function requiresConfigurator(): bool
    {
        return $this->attribute_count > 0 || $this->combo_count > 0;
    }

    /**
     * Bootstrap scoping (spec §5.3): company products available in the POS,
     * optionally narrowed to the config's allowed categories, capped by
     * `limited_product_count` and ordered favourite → service → recently sold.
     * Special products, combo children and open-order products are force-included
     * by the serializer regardless of the cap.
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $query = static::query()
            // The clients index products by category (Dexie `*pos_category_ids`) and read `tax_ids`
            // when pricing a line; the appended attributes materialise these relations into the row.
            ->with(['posCategories:id', 'taxes:id'])
            ->where('company_id', $config->company_id)
            ->where('available_in_pos', true)
            ->where('sale_ok', true)
            ->where('active', true);

        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            $query->where('self_order_available', true);
        }

        if ($config->limit_categories) {
            $categoryIds = PosCategory::posLoadScope($config, $profile)->pluck('id');
            $query->whereHas('posCategories', fn (Builder $q) => $q->whereIn('pos_categories.id', $categoryIds));
        }

        return $query
            ->orderByDesc('is_favorite')
            ->orderByRaw("CASE WHEN product_type = 'service' THEN 0 ELSE 1 END")
            ->orderByDesc('last_sold_at')
            ->orderByDesc('updated_at')
            ->limit($config->limited_product_count);
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            return [
                'id', 'uuid', 'name', 'product_type', 'list_price', 'uom_id', 'color',
                'public_description', 'image_media_id', 'has_image', 'attribute_count',
                'combo_count', 'self_order_available', 'pos_sequence', 'updated_at',
            ];
        }

        return ['*'];
    }
}
