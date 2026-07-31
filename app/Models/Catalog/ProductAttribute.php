<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Enums\AttributeCreateVariant;
use App\Enums\AttributeDisplayType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Attribute definition ("Size", "Colour") — spec §2.B. */
class ProductAttribute extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'product_attributes';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'display_type' => AttributeDisplayType::class,
            'create_variant' => AttributeCreateVariant::class,
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<ProductAttributeValue, $this> */
    public function values(): HasMany
    {
        return $this->hasMany(ProductAttributeValue::class)->orderBy('sequence');
    }

    /** @return HasMany<ProductAttributeLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(ProductAttributeLine::class);
    }

    public function ridesOnLine(): bool
    {
        return $this->create_variant->ridesOnLine();
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->whereHas('lines', fn (Builder $q) => $q->whereIn(
                'product_id',
                Product::posLoadScope($config, $profile)->select('id'),
            ));
    }
}
