<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\LoyaltyMovementType;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable ledger of point movements (spec §2.J).
 *
 * `balance_after` is stored, not derived, so a statement can be printed without
 * replaying the whole ledger. Never sent to a client (spec §5.4).
 */
class CardHistory extends Model
{
    use HasUuid;

    protected $table = 'loyalty_card_histories';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'loyalty_card_id',
        'pos_order_id',
        'movement_type',
        'points',
        'balance_after',
        'description',
        'employee_id',
        'occurred_at',
    ];

    protected function casts(): array
    {
        return [
            'movement_type' => LoyaltyMovementType::class,
            'points' => 'decimal:3',
            'balance_after' => 'decimal:3',
            'occurred_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Card, $this> */
    public function card(): BelongsTo
    {
        return $this->belongsTo(Card::class, 'loyalty_card_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'employee_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForCard(Builder $query, Card|int $card): Builder
    {
        return $query->where('loyalty_card_id', $card instanceof Card ? $card->getKey() : $card);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, LoyaltyMovementType $type): Builder
    {
        return $query->where('movement_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeBetween(Builder $query, \DateTimeInterface|string $from, \DateTimeInterface|string $to): Builder
    {
        return $query->whereBetween('occurred_at', [$from, $to]);
    }
}
