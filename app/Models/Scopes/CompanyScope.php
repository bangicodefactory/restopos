<?php

declare(strict_types=1);

namespace App\Models\Scopes;

use App\Models\Concerns\BelongsToCompany;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Scope;

/**
 * Tenant isolation for every company-owned model (XCT-101, spec §0.6).
 *
 * There was none. `scopeForCompany` existed, was well named, and was called from nowhere — so a
 * second tenant logging into the back office saw the first tenant's registers, products, orders and
 * cash. Sixteen controllers each querying unscoped is not a thing to fix sixteen times: the
 * seventeenth would leak, and so would every model added afterwards. This is a **global** scope,
 * booted by {@see BelongsToCompany}, so a model is isolated by virtue of
 * declaring that it belongs to a company.
 *
 * It applies only when a back-office user is signed in on the `web` guard, which is the whole of
 * what it should touch:
 *
 *  - **Device and API requests** authenticate through their own middleware, not a Laravel guard, so
 *    `Auth::guard('web')->user()` is null there. They are already scoped by the device's config,
 *    and this must not second-guess that — a register pulling its own catalogue is not a tenant
 *    boundary problem.
 *  - **Console, queues and seeders** have no authenticated user either, so migrations and demo data
 *    behave exactly as before.
 *  - **Super admins** cross companies, consistent with `User::hasPermission()` returning true for
 *    everything: that flag is already the platform-operator escape hatch, and inventing a second
 *    rule here would be inconsistent rather than safer.
 *
 * Route-model binding gets the important consequence for free: another tenant's record simply is
 * not found, so `findOrFail` 404s instead of handing it over.
 *
 * What this cannot reach is the query builder, and the back office uses it for the dashboard totals,
 * the reports and the print queue. Those call {@see ActingCompany} directly — which is where the
 * decision below actually lives, so the two surfaces cannot drift apart.
 *
 * Named, not anonymous, so `withoutGlobalScope(CompanyScope::class)` reads as intent at the rare
 * call site that genuinely needs to cross the boundary.
 */
final class CompanyScope implements Scope
{
    public function apply(Builder $builder, Model $model): void
    {
        ActingCompany::scope($builder, $model->getTable().'.company_id');
    }
}
