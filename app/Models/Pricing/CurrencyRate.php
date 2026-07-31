<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\BelongsToCompany;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Historical rate against the company currency; freezes `pos_orders.currency_rate` (spec §2.C). */
class CurrencyRate extends Model
{
    use BelongsToCompany;

    protected $table = 'currency_rates';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'rate_date' => 'date',
            'rate' => 'decimal:12',
        ];
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeLatestFor(Builder $query, int $currencyId, int $companyId): Builder
    {
        return $query->where('currency_id', $currencyId)
            ->where('company_id', $companyId)
            ->orderByDesc('rate_date')
            ->limit(1);
    }
}
