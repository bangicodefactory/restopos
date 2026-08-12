<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\CustomerAccountMoveType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Customer;
use App\Models\Identity\Employee;
use App\Models\User;
use App\Services\Pos\CustomerAccountLedger;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One movement on a customer's tab (REG-208).
 *
 * Append-only by intent, like {@see SessionEvent} and `loyalty_card_histories`: there is no update
 * path and no soft delete, because the value of this table is that it says what happened rather
 * than what is currently true. `customers.account_balance` already holds the latter.
 *
 * Write through {@see CustomerAccountLedger} and nowhere else — `balance_after` and
 * `customers.account_balance` are only correct if a single writer holds the row lock.
 */
final class CustomerAccountMove extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'customer_account_moves';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'move_type' => CustomerAccountMoveType::class,
            'amount' => 'decimal:4',
            'balance_after' => 'decimal:4',
            'occurred_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Customer, $this> */
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<Payment, $this> */
    public function payment(): BelongsTo
    {
        return $this->belongsTo(Payment::class, 'pos_payment_id');
    }

    /** @return BelongsTo<PaymentMethod, $this> */
    public function paymentMethod(): BelongsTo
    {
        return $this->belongsTo(PaymentMethod::class, 'payment_method_id');
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
