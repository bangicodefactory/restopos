<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Global value pool of an attribute ("Red", "XL") — spec §2.B. */
class ProductAttributeValue extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'product_attribute_values';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'is_custom' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<ProductAttribute, $this> */
    public function attribute(): BelongsTo
    {
        return $this->belongsTo(ProductAttribute::class, 'product_attribute_id');
    }

    /** @return HasMany<ProductAttributeLineValue, $this> */
    public function lineValues(): HasMany
    {
        return $this->hasMany(ProductAttributeLineValue::class, 'product_attribute_value_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'product_attribute_id',
            ProductAttribute::posLoadScope($config, $profile)->select('id'),
        );
    }
}
