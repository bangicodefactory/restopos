<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PaymentTransactionState;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Customer;
use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One online payment attempt — phone checkout, kiosk QR, cashier-presented QR
 * (spec §2.F).
 *
 * The transaction is the provider-facing record; a successful one materialises
 * into a {@see Payment}. `reference` is ours and unique, `provider_reference`
 * is theirs.
 */
class PaymentTransaction extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'payment_transactions';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'pos_order_id',
        'payment_provider_id',
        'payment_method_id',
        'reference',
        'provider_reference',
        'amount',
        'currency_id',
        'state',
        'state_message',
        'customer_id',
        'payload',
        'initiated_at',
        'completed_at',
    ];

    protected function casts(): array
    {
        return [
            'amount' => 'decimal:4',
            'state' => PaymentTransactionState::class,
            'payload' => AsArrayObject::class,
            'initiated_at' => 'datetime',
            'completed_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<PaymentProvider, $this> */
    public function provider(): BelongsTo
    {
        return $this->belongsTo(PaymentProvider::class, 'payment_provider_id');
    }

    /** @return BelongsTo<PaymentMethod, $this> */
    public function paymentMethod(): BelongsTo
    {
        return $this->belongsTo(PaymentMethod::class, 'payment_method_id');
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class, 'currency_id');
    }

    /** @return BelongsTo<Customer, $this> */
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'customer_id');
    }

    /** @return HasMany<Payment, $this> */
    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class, 'payment_transaction_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, PaymentTransactionState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeDone(Builder $query): Builder
    {
        return $query->where('state', PaymentTransactionState::Done->value);
    }

    /** Attempts still waiting on the provider — the polling set. @param  Builder<static>  $query */
    public function scopePending(Builder $query): Builder
    {
        return $query->whereIn('state', [
            PaymentTransactionState::Draft->value,
            PaymentTransactionState::Pending->value,
        ]);
    }
}
