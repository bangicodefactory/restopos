<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Models\Audit\NotificationLog;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One coupon / gift card / eWallet / loyalty account instance (spec §2.J).
 *
 * `points` is the authoritative balance; {@see CardHistory} is the immutable
 * ledger that explains it. Cards are **never** bulk-loaded to a client
 * (spec §5.3) — only those referenced by an open order or by a loaded customer.
 */
class Card extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'loyalty_cards';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'loyalty_program_id',
        'company_id',
        'code',
        'barcode',
        'customer_id',
        'points',
        'points_issued_total',
        'points_spent_total',
        'expires_at',
        'use_count',
        'source_pos_order_id',
        'is_paid',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'points' => 'decimal:3',
            'points_issued_total' => 'decimal:3',
            'points_spent_total' => 'decimal:3',
            'expires_at' => 'date',
            'use_count' => 'integer',
            'is_paid' => 'boolean',
            'active' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class, 'loyalty_program_id');
    }

    /** @return BelongsTo<Customer, $this> */
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'customer_id');
    }

    /** The order that issued this card. @return BelongsTo<Order, $this> */
    public function sourceOrder(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'source_pos_order_id');
    }

    /** @return HasMany<CardHistory, $this> */
    public function histories(): HasMany
    {
        return $this->hasMany(CardHistory::class, 'loyalty_card_id')->orderBy('occurred_at');
    }

    /** @return HasMany<OrderPoint, $this> */
    public function orderPoints(): HasMany
    {
        return $this->hasMany(OrderPoint::class, 'loyalty_card_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function orderLines(): HasMany
    {
        return $this->hasMany(OrderLine::class, 'loyalty_card_id');
    }

    /** @return HasMany<NotificationLog, $this> */
    public function notificationLogs(): HasMany
    {
        return $this->hasMany(NotificationLog::class, 'loyalty_card_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForProgram(Builder $query, Program|int $program): Builder
    {
        return $query->where('loyalty_program_id', $program instanceof Program ? $program->getKey() : $program);
    }

    /** @param  Builder<static>  $query */
    public function scopeWithCode(Builder $query, string $code): Builder
    {
        return $query->where(fn (Builder $q) => $q->where('code', $code)->orWhere('barcode', $code));
    }

    /** @param  Builder<static>  $query */
    public function scopeNotExpired(Builder $query, \DateTimeInterface|string|null $on = null): Builder
    {
        $on ??= now();

        return $query->where(fn (Builder $q) => $q->whereNull('expires_at')->orWhere('expires_at', '>=', $on));
    }

    /** @param  Builder<static>  $query */
    public function scopeExpired(Builder $query, \DateTimeInterface|string|null $on = null): Builder
    {
        return $query->whereNotNull('expires_at')->where('expires_at', '<', $on ?? now());
    }

    /** Usable right now: active, unexpired, non-zero balance. @param  Builder<static>  $query */
    public function scopeRedeemable(Builder $query): Builder
    {
        return $query->active()->notExpired()->where('points', '>', 0);
    }

    /** @param  Builder<static>  $query */
    public function scopeForCustomer(Builder $query, Customer|int $customer): Builder
    {
        return $query->where('customer_id', $customer instanceof Customer ? $customer->getKey() : $customer);
    }

    // ----------------------------------------------------------------- helpers

    public function isExpired(): bool
    {
        return $this->expires_at !== null && $this->expires_at->isPast();
    }

    // ----------------------------------------------------------------- loading

    /**
     * Bootstrap scoping (spec §5.3): cards referenced by a loaded open order
     * plus the cards of the loaded customers — never the whole table.
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $orderIds = Order::posLoadScope($config, $profile)->select('pos_orders.id');

        return static::query()
            ->where('company_id', $config->company_id)
            ->active()
            ->where(fn (Builder $q) => $q
                ->whereIn('id', OrderPoint::query()
                    ->whereIn('pos_order_id', $orderIds)
                    ->whereNotNull('loyalty_card_id')
                    ->select('loyalty_card_id'))
                ->orWhereIn('id', OrderLine::query()
                    ->whereIn('pos_order_id', $orderIds)
                    ->whereNotNull('loyalty_card_id')
                    ->select('loyalty_card_id')));
    }
}
