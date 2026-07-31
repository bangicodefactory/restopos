<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Per-session × payment-method closing figures (spec §2.E). */
class SessionPaymentTotal extends Model
{
    protected $table = 'session_payment_totals';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'expected_amount' => 'decimal:4',
            'counted_amount' => 'decimal:4',
            'difference_amount' => 'decimal:4',
            'payment_count' => 'integer',
            'refund_amount' => 'decimal:4',
            'change_amount' => 'decimal:4',
        ];
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<PaymentMethod, $this> */
    public function paymentMethod(): BelongsTo
    {
        return $this->belongsTo(PaymentMethod::class);
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }
}
