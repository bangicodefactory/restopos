<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * "What the kitchen already knows" — the baseline the delta engine diffs
 * against, one row per order (spec §2.H).
 *
 * `server_version` is an optimistic lock: a client submitting a stale version is
 * told "Order Outdated" and must adopt the server snapshot. It replaces Odoo's
 * `metadata.serverDate` string compare, which lost races on multi-till setups.
 */
class OrderPreparationSnapshot extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'order_preparation_snapshots';

    /** @var list<string> */
    protected $fillable = [
        'pos_order_id',
        'snapshot',
        'general_customer_note',
        'internal_note',
        'server_version',
        'server_date',
    ];

    protected function casts(): array
    {
        return [
            'snapshot' => AsArrayObject::class,
            'server_version' => 'integer',
            'server_date' => 'datetime',
        ];
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** Optimistic lock check performed before accepting a client delta. */
    public function isStale(int $clientVersion): bool
    {
        return $clientVersion !== $this->server_version;
    }

    /** Bootstrap scoping (spec §5.3): snapshots of the loaded open orders. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'pos_order_id',
            Order::posLoadScope($config, $profile)->select('pos_orders.id'),
        );
    }
}
