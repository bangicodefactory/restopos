<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\CashMovementType;
use App\Enums\SessionState;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Employee;
use App\Models\Pricing\Currency;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A cashier work period on one register: the container for orders, cash and the
 * closing figures (spec §2.E).
 *
 * "One open session per register" is a database invariant (partial unique index
 * on `pos_config_id` where the session is neither closed nor a rescue), not a
 * race-prone application check.
 */
class PosSession extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'pos_sessions';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'state' => SessionState::class,
            'opened_at' => 'datetime',
            'closed_at' => 'datetime',
            'business_date' => 'date',
            'has_cash_control' => 'boolean',
            'cash_balance_opening' => 'decimal:4',
            'cash_balance_opening_expected' => 'decimal:4',
            'cash_balance_closing_counted' => 'decimal:4',
            'cash_balance_closing_expected' => 'decimal:4',
            'cash_difference' => 'decimal:4',
            'cash_in_total' => 'decimal:4',
            'cash_out_total' => 'decimal:4',
            'order_count' => 'integer',
            'order_amount_total' => 'decimal:4',
            'refund_amount_total' => 'decimal:4',
            'payments_total' => 'decimal:4',
            'is_rescue' => 'boolean',
            'closing_forced' => 'boolean',
            'accounting_exported_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class);
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsTo<User, $this> */
    public function openedByUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'opened_by_user_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function openedByEmployee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'opened_by_employee_id');
    }

    /** @return BelongsTo<User, $this> */
    public function closedByUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'closed_by_user_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function closedByEmployee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'closed_by_employee_id');
    }

    /** @return BelongsTo<PosSession, $this> */
    public function rescuedFrom(): BelongsTo
    {
        return $this->belongsTo(self::class, 'rescued_from_session_id');
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /** @return HasMany<Payment, $this> */
    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class);
    }

    /** @return HasMany<CashMovement, $this> */
    public function cashMovements(): HasMany
    {
        return $this->hasMany(CashMovement::class);
    }

    /** @return HasMany<SessionCashCount, $this> */
    public function cashCounts(): HasMany
    {
        return $this->hasMany(SessionCashCount::class);
    }

    /** @return HasMany<SessionPaymentTotal, $this> */
    public function paymentTotals(): HasMany
    {
        return $this->hasMany(SessionPaymentTotal::class);
    }

    /** @return HasMany<SessionSalesSummary, $this> */
    public function salesSummaries(): HasMany
    {
        return $this->hasMany(SessionSalesSummary::class);
    }

    /** @return HasMany<SessionTaxSummary, $this> */
    public function taxSummaries(): HasMany
    {
        return $this->hasMany(SessionTaxSummary::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->where('state', '!=', SessionState::Closed->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeClosed(Builder $query): Builder
    {
        return $query->where('state', SessionState::Closed->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeOnBusinessDate(Builder $query, \DateTimeInterface|string $date): Builder
    {
        return $query->whereDate('business_date', $date);
    }

    public function isOpen(): bool
    {
        return $this->state->isOpen();
    }

    /** Opening float + cash payments + cash in/out − change given. */
    public function expectedCash(): string
    {
        $movements = $this->cashMovements()
            ->whereNot('movement_type', CashMovementType::Difference->value)
            ->sum('amount');

        $cashPayments = $this->payments()
            ->whereHas('paymentMethod', fn (Builder $q) => $q->where('is_cash_count', true))
            ->sum('amount');

        return bcadd((string) $this->cash_balance_opening, bcadd((string) $movements, (string) $cashPayments, 4), 4);
    }

    public function hasDraftOrders(): bool
    {
        return $this->orders()->where('state', 'draft')->exists();
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->forConfig($config)->open();
    }
}
