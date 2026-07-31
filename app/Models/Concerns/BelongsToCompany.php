<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\Identity\Company;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Every catalog, config, order and money table is tenant-scoped by `company_id`
 * (spec §0.6). Cross-company references are forbidden by application validation.
 */
trait BelongsToCompany
{
    /** @return BelongsTo<Company, $this> */
    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    /**
     * @param  Builder<static>  $query
     */
    public function scopeForCompany(Builder $query, Company|int|null $company): Builder
    {
        if ($company === null) {
            return $query;
        }

        return $query->where($this->getTable().'.company_id', $company instanceof Company ? $company->getKey() : $company);
    }
}
