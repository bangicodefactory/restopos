<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Enums\UomType;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Selling unit (Units, kg, g, L, hour) — spec §2.B. */
class Uom extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'uoms';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'uom_type' => UomType::class,
            'factor' => 'decimal:12',
            'rounding' => 'decimal:6',
            'is_pos_groupable' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<UomCategory, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(UomCategory::class, 'uom_category_id');
    }

    /** @return HasMany<Product, $this> */
    public function products(): HasMany
    {
        return $this->hasMany(Product::class);
    }

    /** @return HasMany<ProductPackaging, $this> */
    public function packagings(): HasMany
    {
        return $this->hasMany(ProductPackaging::class);
    }

    /** All UoMs are loaded, archived ones included (spec §5.3). */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->orderBy('id');
    }
}
