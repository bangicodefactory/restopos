<?php

declare(strict_types=1);

namespace App\Models\Catalog;

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
use Illuminate\Support\Collection;

/** The actually-sold SKU (spec §2.B). */
class ProductVariant extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'product_variants';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'price_extra' => 'decimal:4',
            'list_price' => 'decimal:4',
            'standard_price' => 'decimal:4',
            'on_hand_qty' => 'decimal:3',
            'self_order_available' => 'boolean',
            'is_active_combination' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /**
     * What the till button reads: the product, plus the suffix that distinguishes this variant.
     *
     * Denormalised on purpose — `display_name` is in `posLoadFields`, so the register renders it
     * directly rather than joining. Which means it has to be *rewritten* whenever either half moves:
     * renaming a product left every variant showing the old name on the till indefinitely, because
     * nothing propagated. Probed before the fix (BAN-409 review).
     */
    public static function displayNameFor(Product $product, ?string $suffix): string
    {
        $suffix = trim((string) $suffix);

        return $suffix === '' ? (string) $product->name : $product->name.' '.$suffix;
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @return HasMany<ProductPackaging, $this> */
    public function packagings(): HasMany
    {
        return $this->hasMany(ProductPackaging::class);
    }

    /** @return BelongsToMany<ProductAttributeLineValue, $this> */
    public function attributeValues(): BelongsToMany
    {
        return $this->belongsToMany(
            ProductAttributeLineValue::class,
            'product_variant_attribute_value',
            'product_variant_id',
            'product_attribute_line_value_id',
        );
    }

    /** Per-variant override: if any row exists it REPLACES the template's taxes. */
    /** @return BelongsToMany<Tax, $this> */
    public function taxes(): BelongsToMany
    {
        return $this->belongsToMany(Tax::class, 'product_variant_tax');
    }

    /** @return HasMany<ComboItem, $this> */
    public function comboItems(): HasMany
    {
        return $this->hasMany(ComboItem::class);
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeSellable(Builder $query): Builder
    {
        return $query->where('active', true)->where('is_active_combination', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeByBarcode(Builder $query, string $barcode): Builder
    {
        return $query->where('barcode', $barcode);
    }

    /** Effective sales price: the variant override, or template price + extras. */
    public function effectivePrice(): string
    {
        if ($this->list_price !== null) {
            return (string) $this->list_price;
        }

        return bcadd((string) $this->product->list_price, (string) $this->price_extra, 4);
    }

    /** The tax set that actually applies (variant override wins). */
    public function applicableTaxes(): Collection
    {
        $own = $this->relationLoaded('taxes') ? $this->taxes : $this->taxes()->get();

        return $own->isNotEmpty() ? $own : $this->product->taxes;
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->whereIn('product_id', Product::posLoadScope($config, $profile)->select('id'))
            ->when($profile === PosLoadable::PROFILE_SELF_ORDER, fn (Builder $q) => $q->where('self_order_available', true));
    }
}
