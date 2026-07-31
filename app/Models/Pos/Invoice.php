<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\InvoiceState;
use App\Enums\InvoiceType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Customer;
use App\Models\Identity\MediaFile;
use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A lean, immutable customer invoice document — not a ledger entry (spec §2.F).
 *
 * `customer_snapshot` freezes the billing identity at issue time so a later
 * edit of the customer record never rewrites history. Never bulk-loaded to a
 * client (spec §5.4); fetched on demand.
 */
class Invoice extends Model
{
    use BelongsToCompany;
    use HasFactory;
    use HasUuid;

    protected $table = 'pos_invoices';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'pos_order_id',
        'number',
        'invoice_type',
        'reversed_invoice_id',
        'customer_id',
        'customer_snapshot',
        'issued_at',
        'currency_id',
        'amount_untaxed',
        'amount_tax',
        'amount_total',
        'tax_details',
        'pdf_media_id',
        'sent_at',
        'state',
    ];

    protected function casts(): array
    {
        return [
            'invoice_type' => InvoiceType::class,
            'customer_snapshot' => AsArrayObject::class,
            'issued_at' => 'datetime',
            'amount_untaxed' => 'decimal:4',
            'amount_tax' => 'decimal:4',
            'amount_total' => 'decimal:4',
            'tax_details' => AsArrayObject::class,
            'sent_at' => 'datetime',
            'state' => InvoiceState::class,
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** The invoice this credit note reverses. @return BelongsTo<Invoice, $this> */
    public function reversedInvoice(): BelongsTo
    {
        return $this->belongsTo(self::class, 'reversed_invoice_id');
    }

    /** @return HasMany<Invoice, $this> */
    public function reversals(): HasMany
    {
        return $this->hasMany(self::class, 'reversed_invoice_id');
    }

    /** @return BelongsTo<Customer, $this> */
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'customer_id');
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class, 'currency_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function pdf(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'pdf_media_id');
    }

    /** @return HasMany<InvoiceLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(InvoiceLine::class, 'pos_invoice_id')->orderBy('sort_order');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeIssued(Builder $query): Builder
    {
        return $query->whereIn('state', [InvoiceState::Issued->value, InvoiceState::Sent->value]);
    }

    /** @param  Builder<static>  $query */
    public function scopeDraft(Builder $query): Builder
    {
        return $query->where('state', InvoiceState::Draft->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, InvoiceType $type): Builder
    {
        return $query->where('invoice_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeUnsent(Builder $query): Builder
    {
        return $query->whereNull('sent_at');
    }

    public function isCreditNote(): bool
    {
        return $this->invoice_type === InvoiceType::CreditNote;
    }
}
