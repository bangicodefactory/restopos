<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Per-tax base/amount of a session — the tax half of the export (spec §2.E). */
class SessionTaxSummary extends Model
{
    protected $table = 'session_tax_summaries';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'is_refund' => 'boolean',
            'base_amount' => 'decimal:4',
            'tax_amount' => 'decimal:4',
            'tax_rate' => 'decimal:4',
        ];
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<Tax, $this> */
    public function tax(): BelongsTo
    {
        return $this->belongsTo(Tax::class);
    }

    /** @return BelongsTo<TaxGroup, $this> */
    public function taxGroup(): BelongsTo
    {
        return $this->belongsTo(TaxGroup::class);
    }
}
