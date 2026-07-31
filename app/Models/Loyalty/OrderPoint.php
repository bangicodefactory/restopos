<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\LoyaltyPointState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * The point change claimed by ONE order — table `pos_order_loyalty_points`
 * (spec §2.J).
 *
 * Staged as `pending` when the order syncs and only confirmed at payment, so an
 * abandoned or offline-cancelled order never burns a customer's balance. A
 * rejected claim carries `rejection_reason` back to the till.
 */
class OrderPoint extends Model implements PosLoadable
{
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'pos_order_loyalty_points';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_id',
        'loyalty_card_id',
        'loyalty_program_id',
        'points_delta',
        'new_card_code',
        'state',
        'rejection_reason',
        'confirmed_at',
    ];

    protected function casts(): array
    {
        return [
            'points_delta' => 'decimal:3',
            'state' => LoyaltyPointState::class,
            'confirmed_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** Null while the card is still to be created (`new_card_code`). @return BelongsTo<Card, $this> */
    public function card(): BelongsTo
    {
        return $this->belongsTo(Card::class, 'loyalty_card_id');
    }

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class, 'loyalty_program_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopePending(Builder $query): Builder
    {
        return $query->where('state', LoyaltyPointState::Pending->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeConfirmed(Builder $query): Builder
    {
        return $query->where('state', LoyaltyPointState::Confirmed->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, LoyaltyPointState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** Bootstrap scoping (spec §5.3): claims of the loaded open orders. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'pos_order_id',
            Order::posLoadScope($config, $profile)->select('pos_orders.id'),
        );
    }
}
