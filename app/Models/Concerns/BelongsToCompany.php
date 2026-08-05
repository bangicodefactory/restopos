<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\Identity\Company;
use App\Models\Scopes\CompanyScope;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Every catalog, config, order and money table is tenant-scoped by `company_id`
 * (spec §0.6). Cross-company references are forbidden by application validation.
 */
trait BelongsToCompany
{
    /**
     * Declaring that a model belongs to a company is what isolates it (XCT-101).
     *
     * The scope is global and booted here rather than applied at each query site: there are 45
     * models and 16 back-office controllers, and a rule enforced by remembering it is a rule that
     * leaks the first time someone forgets. See {@see CompanyScope} for what it does and does not
     * touch.
     */
    public static function bootBelongsToCompany(): void
    {
        static::addGlobalScope(new CompanyScope);
    }

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
