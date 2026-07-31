<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Frozen revenue breakdown of a closed session — the sales half of the export (spec §2.E). */
class SessionSalesSummary extends Model
{
    protected $table = 'session_sales_summaries';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'is_refund' => 'boolean',
            'quantity' => 'decimal:3',
            'base_amount' => 'decimal:4',
            'discount_amount' => 'decimal:4',
            'tax_amount' => 'decimal:4',
            'total_amount' => 'decimal:4',
            'cost_amount' => 'decimal:4',
        ];
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<PosCategory, $this> */
    public function posCategory(): BelongsTo
    {
        return $this->belongsTo(PosCategory::class);
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeSales(Builder $query): Builder
    {
        return $query->where('is_refund', false);
    }

    /** @param  Builder<static>  $query */
    public function scopeRefunds(Builder $query): Builder
    {
        return $query->where('is_refund', true);
    }
}
