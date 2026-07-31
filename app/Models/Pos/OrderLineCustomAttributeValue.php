<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Models\Catalog\ProductAttributeLineValue;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * The free-text value typed for a `custom` attribute value on one line —
 * "no onions", an engraving, a name on a cake (spec §2.F).
 */
class OrderLineCustomAttributeValue extends Model implements PosLoadable
{
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'pos_order_line_custom_attribute_values';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_line_id',
        'product_attribute_line_value_id',
        'custom_value',
    ];

    /** @return BelongsTo<OrderLine, $this> */
    public function orderLine(): BelongsTo
    {
        return $this->belongsTo(OrderLine::class, 'pos_order_line_id');
    }

    /** @return BelongsTo<ProductAttributeLineValue, $this> */
    public function attributeLineValue(): BelongsTo
    {
        return $this->belongsTo(ProductAttributeLineValue::class, 'product_attribute_line_value_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForLine(Builder $query, OrderLine|int $line): Builder
    {
        return $query->where('pos_order_line_id', $line instanceof OrderLine ? $line->getKey() : $line);
    }

    /** Bootstrap scoping (spec §5.3): children of the loaded open orders' lines. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'pos_order_line_id',
            OrderLine::posLoadScope($config, $profile)->select('pos_order_lines.id'),
        );
    }
}
