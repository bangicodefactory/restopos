<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PaymentStatus;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Identity\Employee;
use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * One tender line against an order (spec §2.F).
 *
 * `amount` is signed: change given back and refunds are negative. Terminal
 * metadata is stored, but never a full PAN — only `card_last4` and the auth
 * code, which is what a dispute actually needs.
 */
class Payment extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'pos_payments';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_id',
        'pos_session_id',
        'payment_method_id',
        'company_id',
        'currency_id',
        'amount',
        'amount_company_currency',
        'is_change',
        'is_refund',
        'label',
        'paid_at',
        'customer_id',
        'employee_id',
        'pos_device_id',
        'payment_status',
        'card_type',
        'card_brand',
        'card_last4',
        'cardholder_name',
        'auth_code',
        'transaction_reference',
        'issuer_bank',
        'entry_mode',
        'terminal_payload',
        'terminal_ticket',
        'payment_transaction_id',
    ];

    protected function casts(): array
    {
        return [
            'amount' => 'decimal:4',
            'amount_company_currency' => 'decimal:4',
            'is_change' => 'boolean',
            'is_refund' => 'boolean',
            'paid_at' => 'datetime',
            'payment_status' => PaymentStatus::class,
            'terminal_payload' => AsArrayObject::class,
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
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

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'employee_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    /** @return BelongsTo<PaymentTransaction, $this> */
    public function transaction(): BelongsTo
    {
        return $this->belongsTo(PaymentTransaction::class, 'payment_transaction_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopeForSession(Builder $query, PosSession|int $session): Builder
    {
        return $query->where('pos_session_id', $session instanceof PosSession ? $session->getKey() : $session);
    }

    /** @param  Builder<static>  $query */
    public function scopeForMethod(Builder $query, PaymentMethod|int $method): Builder
    {
        return $query->where('payment_method_id', $method instanceof PaymentMethod ? $method->getKey() : $method);
    }

    /** Tenders that count towards the cash drawer. @param  Builder<static>  $query */
    public function scopeCash(Builder $query): Builder
    {
        return $query->whereHas('paymentMethod', fn (Builder $q) => $q->where('is_cash_count', true));
    }

    /** @param  Builder<static>  $query */
    public function scopeChange(Builder $query): Builder
    {
        return $query->where('is_change', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeSettled(Builder $query): Builder
    {
        return $query->where('payment_status', PaymentStatus::Done->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeInStatus(Builder $query, PaymentStatus $status): Builder
    {
        return $query->where('payment_status', $status->value);
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): payments of the loaded open orders. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'pos_order_id',
            Order::posLoadScope($config, $profile)->select('pos_orders.id'),
        );
    }
}
