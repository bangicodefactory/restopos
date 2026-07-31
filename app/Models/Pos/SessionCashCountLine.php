<?php

declare(strict_types=1);

namespace App\Models\Pos;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** One denomination row of a drawer count (spec §2.E). */
class SessionCashCountLine extends Model
{
    protected $table = 'session_cash_count_lines';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'denomination_value' => 'decimal:4',
            'quantity' => 'integer',
            'subtotal' => 'decimal:4',
        ];
    }

    /** @return BelongsTo<SessionCashCount, $this> */
    public function count(): BelongsTo
    {
        return $this->belongsTo(SessionCashCount::class, 'session_cash_count_id');
    }

    /** @return BelongsTo<PosBill, $this> */
    public function bill(): BelongsTo
    {
        return $this->belongsTo(PosBill::class, 'pos_bill_id');
    }
}
