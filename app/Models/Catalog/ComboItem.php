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

/** A pickable option inside a combo (spec §2.B). */
class ComboItem extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'combo_items';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'extra_price' => 'decimal:4',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Combo, $this> */
    public function combo(): BelongsTo
    {
        return $this->belongsTo(Combo::class);
    }

    /** @return BelongsTo<ProductVariant, $this> */
    public function variant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'product_variant_id');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('combo_id', Combo::posLoadScope($config, $profile)->select('id'));
    }
}
