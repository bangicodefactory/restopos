<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ScopedExists;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * `Rule::exists` may not point at a company-owned table.
 *
 * `CompanyScope` is a global *Eloquent* scope, and its own docblock says what it cannot reach: the
 * query builder. `Rule::exists` is the query builder. So a validation rule written as
 * `Rule::exists('cash_roundings', 'id')` asks "does any tenant have this row?" and answers yes —
 * the model's isolation offers no cover at all, because the model is never involved.
 *
 * That is not hypothetical. BAN-466 introduced exactly this rule for `cash_rounding_id`, on a
 * comment asserting the table was venue-wide reference data. It carries a `company_id` and uses
 * `BelongsToCompany`. Probed during review: another company's rounding rule attached, 302, no
 * complaint — the same cross-tenant class the ticket had flagged for the pivots, reintroduced by
 * the fix for it.
 *
 * The rule to follow instead is the one `PosConfigController::ownedIds()` and
 * `PosConfigRequest::owned()` use: resolve through the scoped model, and add an explicit
 * `company_id` filter so a super-admin — for whom the scope steps aside — cannot cross either.
 *
 * An unscoped `exists` on a table with no `company_id` is fine and stays fine; `currencies`,
 * `countries` and `languages` are genuinely shared.
 */

/**
 * Every `Rule::exists('table', ...)` in the request layer, read from source.
 *
 * @return array<string, list<string>> table => files
 */
function existsRules(): array
{
    $found = [];

    $files = array_merge(
        glob(app_path('Http/Requests/**/*.php')) ?: [],
        glob(app_path('Http/Requests/*.php')) ?: [],
        glob(app_path('Http/Controllers/Backoffice/*.php')) ?: [],
    );

    foreach ($files as $file) {
        preg_match_all(
            "/Rule::exists\(\s*'([a-z_]+)'/",
            (string) file_get_contents($file),
            $matches,
        );

        foreach ($matches[1] as $table) {
            $found[$table][] = basename($file);
        }
    }

    return $found;
}

it('never validates ownership of a tenant table through the query builder', function (): void {
    $offenders = [];

    foreach (existsRules() as $table => $files) {
        if (! Schema::hasTable($table)) {
            $offenders[] = "{$table} does not exist (".implode(', ', array_unique($files)).')';

            continue;
        }

        if (Schema::hasColumn($table, 'company_id')) {
            $offenders[] = "{$table} is company-owned (".implode(', ', array_unique($files)).')';
        }
    }

    expect($offenders)->toBe([], 'Rule::exists bypasses CompanyScope: '.implode(' · ', $offenders));
});

it('finds the rules at all, so a passing run means something', function (): void {
    // Without this, a regex that stopped matching would make the guard above pass on an empty set —
    // the quietest way for a guard to stop guarding.
    expect(existsRules())->not->toBeEmpty();
});
