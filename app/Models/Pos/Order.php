<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\OrderPrepState;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Models\Audit\OrderEditLog;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Identity\Employee;
use App\Models\Kitchen\OrderPreparationSnapshot;
use App\Models\Kitchen\PrepOrder;
use App\Models\Kitchen\PrintJob;
use App\Models\Loyalty\Card;
use App\Models\Loyalty\OrderPoint;
use App\Models\Pricing\Currency;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Models\Restaurant\OrderCourse;
use App\Models\Restaurant\OrderMerge;
use App\Models\Restaurant\Table;
use App\Models\User;
use App\Support\Tax\TaxEngine;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * A ticket — the centre of the whole system (spec §2.F).
 *
 * uuid-first: the client mints the `uuid`, the server never re-issues one, and
 * `POST /api/pos/sync` is a pure upsert keyed on it. Every `amount_*` column is
 * recomputed server-side by {@see TaxEngine}; the client's
 * numbers are a hint used only for a mismatch warning (docs/CONVENTIONS.md).
 */
class Order extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'pos_orders';

    /** @var list<string> */
    protected $fillable = [
        // identity & routing
        'uuid',
        'pos_session_id',
        'pos_config_id',
        'company_id',
        'pos_device_id',
        'name',
        'receipt_number',
        'tracking_number',
        'sequence_number',
        'access_token',
        'ticket_code',
        'source',

        // business
        'state',
        'ordered_at',
        'paid_at',
        'closed_at',
        'cancelled_at',
        'cancel_reason',
        'customer_id',
        'employee_id',
        'user_id',
        'pricelist_id',
        'fiscal_position_id',
        'pos_preset_id',
        'preset_time',
        'currency_id',
        'currency_rate',
        'floating_order_name',

        // amounts
        'amount_untaxed',
        'amount_tax',
        'amount_total',
        'amount_rounding',
        'amount_paid',
        'amount_change',
        'amount_due',
        'amount_write_off',
        'amount_discount',
        'total_cost',
        'margin',
        'margin_percent',
        'tax_details',

        // restaurant
        'restaurant_table_id',
        'guest_count',
        'is_tipped',
        'tip_amount',
        'split_from_order_id',
        'split_letter',
        'merged_into_order_id',

        // refund / invoice
        'is_refund',
        'refunded_order_id',
        'refund_count',
        'has_refundable_lines',
        'to_invoice',
        'pos_invoice_id',

        // kitchen & notes
        'general_customer_note',
        'internal_note',
        'prep_state',
        'unsent_change_count',
        'last_prep_sent_at',

        // self-order
        'self_order_table_id',
        'table_stand_number',
        'customer_email',
        'customer_phone',
        'use_self_online_payment',

        // audit / print
        'print_count',
        'is_edited',
        'has_deleted_line',
        'client_created_at',
        'synced_at',
        'ui_state',
    ];

    protected $hidden = ['access_token'];

    protected function casts(): array
    {
        return [
            'sequence_number' => 'integer',
            'source' => OrderSource::class,

            'state' => OrderState::class,
            'ordered_at' => 'datetime',
            'paid_at' => 'datetime',
            'closed_at' => 'datetime',
            'cancelled_at' => 'datetime',
            'preset_time' => 'datetime',
            'currency_rate' => 'decimal:12',

            'amount_untaxed' => 'decimal:4',
            'amount_tax' => 'decimal:4',
            'amount_total' => 'decimal:4',
            'amount_rounding' => 'decimal:4',
            'amount_paid' => 'decimal:4',
            'amount_change' => 'decimal:4',
            'amount_due' => 'decimal:4',
            'amount_write_off' => 'decimal:4',
            'amount_discount' => 'decimal:4',
            'total_cost' => 'decimal:4',
            'margin' => 'decimal:4',
            'margin_percent' => 'decimal:4',
            'tax_details' => AsArrayObject::class,

            'guest_count' => 'integer',
            'is_tipped' => 'boolean',
            'tip_amount' => 'decimal:4',

            'is_refund' => 'boolean',
            'refund_count' => 'integer',
            'has_refundable_lines' => 'boolean',
            'to_invoice' => 'boolean',

            'prep_state' => OrderPrepState::class,
            'unsent_change_count' => 'integer',
            'last_prep_sent_at' => 'datetime',

            'use_self_online_payment' => 'boolean',

            'print_count' => 'integer',
            'is_edited' => 'boolean',
            'has_deleted_line' => 'boolean',
            'client_created_at' => 'datetime',
            'synced_at' => 'datetime',
            'ui_state' => AsArrayObject::class,
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
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

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }

    /** @return BelongsTo<Pricelist, $this> */
    public function pricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class, 'pricelist_id');
    }

    /** @return BelongsTo<FiscalPosition, $this> */
    public function fiscalPosition(): BelongsTo
    {
        return $this->belongsTo(FiscalPosition::class, 'fiscal_position_id');
    }

    /** @return BelongsTo<PosPreset, $this> */
    public function preset(): BelongsTo
    {
        return $this->belongsTo(PosPreset::class, 'pos_preset_id');
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class, 'currency_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(OrderLine::class, 'pos_order_id');
    }

    /** @return HasMany<Payment, $this> */
    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class, 'pos_order_id');
    }

    /** @return HasMany<PaymentTransaction, $this> */
    public function paymentTransactions(): HasMany
    {
        return $this->hasMany(PaymentTransaction::class, 'pos_order_id');
    }

    /** @return HasMany<OrderCourse, $this> */
    public function courses(): HasMany
    {
        return $this->hasMany(OrderCourse::class, 'pos_order_id')->orderBy('course_index');
    }

    /** @return BelongsTo<Table, $this> */
    public function restaurantTable(): BelongsTo
    {
        return $this->belongsTo(Table::class, 'restaurant_table_id');
    }

    /** The table whose QR code opened this order. @return BelongsTo<Table, $this> */
    public function selfOrderTable(): BelongsTo
    {
        return $this->belongsTo(Table::class, 'self_order_table_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function splitFromOrder(): BelongsTo
    {
        return $this->belongsTo(self::class, 'split_from_order_id');
    }

    /** @return HasMany<Order, $this> */
    public function splitOrders(): HasMany
    {
        return $this->hasMany(self::class, 'split_from_order_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function mergedIntoOrder(): BelongsTo
    {
        return $this->belongsTo(self::class, 'merged_into_order_id');
    }

    /** @return HasMany<Order, $this> */
    public function mergedOrders(): HasMany
    {
        return $this->hasMany(self::class, 'merged_into_order_id');
    }

    /** @return HasMany<OrderMerge, $this> */
    public function mergesAsSource(): HasMany
    {
        return $this->hasMany(OrderMerge::class, 'source_order_id');
    }

    /** @return HasMany<OrderMerge, $this> */
    public function mergesAsTarget(): HasMany
    {
        return $this->hasMany(OrderMerge::class, 'target_order_id');
    }

    /** The sale this refund reverses. @return BelongsTo<Order, $this> */
    public function refundedOrder(): BelongsTo
    {
        return $this->belongsTo(self::class, 'refunded_order_id');
    }

    /** @return HasMany<Order, $this> */
    public function refunds(): HasMany
    {
        return $this->hasMany(self::class, 'refunded_order_id');
    }

    /** The 1:1 invoice document (`pos_invoices.pos_order_id`). @return HasOne<Invoice, $this> */
    public function invoice(): HasOne
    {
        return $this->hasOne(Invoice::class, 'pos_order_id');
    }

    /** The denormalised back-reference used for fast filtering. @return BelongsTo<Invoice, $this> */
    public function linkedInvoice(): BelongsTo
    {
        return $this->belongsTo(Invoice::class, 'pos_invoice_id');
    }

    /** What the kitchen already knows. @return HasOne<OrderPreparationSnapshot, $this> */
    public function preparationSnapshot(): HasOne
    {
        return $this->hasOne(OrderPreparationSnapshot::class, 'pos_order_id');
    }

    /** @return HasMany<PrepOrder, $this> */
    public function prepOrders(): HasMany
    {
        return $this->hasMany(PrepOrder::class, 'pos_order_id');
    }

    /** @return HasMany<PrintJob, $this> */
    public function printJobs(): HasMany
    {
        return $this->hasMany(PrintJob::class, 'pos_order_id');
    }

    /** @return HasMany<OrderPoint, $this> */
    public function loyaltyPoints(): HasMany
    {
        return $this->hasMany(OrderPoint::class, 'pos_order_id');
    }

    /** Cards issued by this order (gift cards, next-order coupons). @return HasMany<Card, $this> */
    public function issuedLoyaltyCards(): HasMany
    {
        return $this->hasMany(Card::class, 'source_pos_order_id');
    }

    /** @return HasMany<OrderEditLog, $this> */
    public function editLogs(): HasMany
    {
        return $this->hasMany(OrderEditLog::class, 'pos_order_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeDraft(Builder $query): Builder
    {
        return $query->where('state', OrderState::Draft->value);
    }

    /** Draft and not deleted — the "parked / open ticket" set. @param  Builder<static>  $query */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->where('state', OrderState::Draft->value)->whereNull('deleted_at');
    }

    /** @param  Builder<static>  $query */
    public function scopePaid(Builder $query): Builder
    {
        return $query->whereIn('state', [OrderState::Paid->value, OrderState::Done->value]);
    }

    /** @param  Builder<static>  $query */
    public function scopeCancelled(Builder $query): Builder
    {
        return $query->where('state', OrderState::Cancelled->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, OrderState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeForSession(Builder $query, PosSession|int $session): Builder
    {
        return $query->where('pos_session_id', $session instanceof PosSession ? $session->getKey() : $session);
    }

    /** @param  Builder<static>  $query */
    public function scopeForTable(Builder $query, Table|int $table): Builder
    {
        return $query->where('restaurant_table_id', $table instanceof Table ? $table->getKey() : $table);
    }

    /** @param  Builder<static>  $query */
    public function scopeRefunds(Builder $query): Builder
    {
        return $query->where('is_refund', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeFromSelfOrder(Builder $query): Builder
    {
        return $query->whereIn('source', [OrderSource::Mobile->value, OrderSource::Kiosk->value]);
    }

    /** Orders the kitchen still owes something on. @param  Builder<static>  $query */
    public function scopeAwaitingPreparation(Builder $query): Builder
    {
        return $query->whereIn('prep_state', [
            OrderPrepState::Pending->value,
            OrderPrepState::Sent->value,
            OrderPrepState::PartiallyReady->value,
        ]);
    }

    // ----------------------------------------------------------------- helpers

    public function isDraft(): bool
    {
        return $this->state === OrderState::Draft;
    }

    public function isPaid(): bool
    {
        return $this->state === OrderState::Paid || $this->state === OrderState::Done;
    }

    public function hasUnsentChanges(): bool
    {
        return $this->unsent_change_count > 0;
    }

    // ----------------------------------------------------------------- loading

    /**
     * Bootstrap scoping (spec §5.3): draft orders of this config and of its
     * trusted peers are restored at startup; when self-ordering is on, draft
     * mobile/kiosk orders come along too.
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $configIds = $config->trustedConfigs()->pluck('pos_configs.id')->all();
        $configIds[] = $config->getKey();

        return static::query()
            ->where('company_id', $config->company_id)
            ->whereIn('pos_config_id', $configIds)
            ->open()
            ->orderBy('ordered_at');
    }
}
