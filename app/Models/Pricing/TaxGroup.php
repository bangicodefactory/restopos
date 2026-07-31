<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Receipt grouping of taxes ("VAT 21%", "Eco-tax") — spec §2.C. */
class TaxGroup extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'tax_groups';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['sequence' => 'integer'];
    }

    /** @return HasMany<Tax, $this> */
    public function taxes(): HasMany
    {
        return $this->hasMany(Tax::class);
    }

    public function receiptLabel(): string
    {
        return $this->receipt_label ?: $this->name;
    }
}
