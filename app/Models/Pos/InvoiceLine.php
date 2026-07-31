<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\InvoiceLineType;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One printed row of an invoice (spec §2.F).
 *
 * Product lines mirror an order line; `section`, `note`, `rounding` and
 * `discount` rows exist only on the document and have no order-line counterpart.
 */
class InvoiceLine extends Model
{
    protected $table = 'pos_invoice_lines';

    /** @var list<string> */
    protected $fillable = [
        'pos_invoice_id',
        'pos_order_line_id',
        'line_type',
        'description',
        'quantity',
        'price_unit',
        'discount_percent',
        'price_subtotal',
        'price_subtotal_incl',
        'tax_details',
        'sort_order',
    ];

    protected function casts(): array
    {
        return [
            'line_type' => InvoiceLineType::class,
            'quantity' => 'decimal:3',
            'price_unit' => 'decimal:4',
            'discount_percent' => 'decimal:4',
            'price_subtotal' => 'decimal:4',
            'price_subtotal_incl' => 'decimal:4',
            'tax_details' => AsArrayObject::class,
            'sort_order' => 'integer',
        ];
    }

    /** @return BelongsTo<Invoice, $this> */
    public function invoice(): BelongsTo
    {
        return $this->belongsTo(Invoice::class, 'pos_invoice_id');
    }

    /** @return BelongsTo<OrderLine, $this> */
    public function orderLine(): BelongsTo
    {
        return $this->belongsTo(OrderLine::class, 'pos_order_line_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForInvoice(Builder $query, Invoice|int $invoice): Builder
    {
        return $query->where('pos_invoice_id', $invoice instanceof Invoice ? $invoice->getKey() : $invoice);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, InvoiceLineType $type): Builder
    {
        return $query->where('line_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeProducts(Builder $query): Builder
    {
        return $query->where('line_type', InvoiceLineType::Product->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('sort_order')->orderBy('id');
    }
}
