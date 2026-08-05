<?php

declare(strict_types=1);

namespace App\Support\Tenancy;

use App\Models\Scopes\CompanyScope;
use Illuminate\Contracts\Database\Query\Builder;
use Illuminate\Support\Facades\Auth;

/**
 * Who the back office is acting as, and what that means for a query (XCT-101).
 *
 * {@see CompanyScope} isolates every Eloquent model. It cannot isolate the query builder, and the
 * back office uses it heavily: the dashboard's revenue figures, the sales reports and the print
 * queue are all raw `table()` calls. Those are a second query surface that no Eloquent mechanism
 * reaches, and leaving them out is not a smaller version of the bug — the dashboard is the first
 * page after login, so an unscoped `sum(amount_total)` there publishes a competitor's daily takings.
 *
 * So the rule lives here, once, and both surfaces consume it. Three branches, in this order:
 *
 *  1. **Nobody signed in, or a super admin** — no restriction. Console, queues, seeders and device
 *     requests have no `web` user; super admins cross companies everywhere else in the app.
 *  2. **Signed in, no company** — sees nothing. Treating "no company" as "every company" is how an
 *     under-configured account becomes a breach.
 *  3. **Signed in with a company** — that company only.
 *
 * Tables without a `company_id` of their own (`session_sales_summaries` and friends) are not scoped
 * with this. They hang off a session, so they are isolated by scoping the session ids they are
 * looked up by — scope the parent, and the children follow.
 */
final class ActingCompany
{
    /**
     * Restrict a query builder to the acting company, the same way the global scope restricts Eloquent.
     *
     * @param  Builder  $query  a query builder — `$column` must be qualified when the query joins
     */
    public static function scope(Builder $query, string $column = 'company_id'): void
    {
        $companyId = self::id();

        if ($companyId === self::UNRESTRICTED) {
            return;
        }

        if ($companyId === null) {
            $query->whereRaw('1 = 0');

            return;
        }

        $query->where($column, $companyId);
    }

    /**
     * The acting company id, `UNRESTRICTED` when the caller may cross companies, or null when the
     * caller is signed in but belongs to nowhere and so may see nothing.
     */
    public static function id(): int|string|null
    {
        $user = Auth::guard('web')->user();

        if ($user === null || $user->is_super_admin === true) {
            return self::UNRESTRICTED;
        }

        return $user->company_id;
    }

    /**
     * Distinct from both a real id and from null, so "may see everything" can never be confused with
     * "belongs to no company" — the two answers that must not collapse into each other.
     */
    public const UNRESTRICTED = '*';
}
