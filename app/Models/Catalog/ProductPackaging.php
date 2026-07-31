<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Per-packaging barcode ("case of 12") — spec §2.B. */
class ProductPackaging extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'product_packagings';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['qty' => 'decimal:3'];
    }

    /** @return BelongsTo<ProductVariant, $this> */
    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'product_variant_id');
    }

    /** @return BelongsTo<Uom, $this> */
    public function uom(): BelongsTo
    {
        return $this->belongsTo(Uom::class);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'product_variant_id',
            ProductVariant::posLoadScope($config, $profile)->select('id'),
        );
    }
}
