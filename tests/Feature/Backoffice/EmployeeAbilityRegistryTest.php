<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\EmployeeAbilityRegistry;

use App\Support\Auth\EmployeeAbilities;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

uses(TestCase::class);

/**
 * The registry and the code that checks abilities must agree — axis 2 (BAN-451).
 *
 * `EmployeeAbilities` is the fixed set an operator may grant from. Two ways it can go wrong, and
 * neither fails anywhere else:
 *
 *  - an ability the **config** grants that the registry omits is ungrantable and invisible in the
 *    matrix, so a venue upgrading would silently lose it
 *  - an ability the **registry** lists that nothing checks is a promise the product does not keep:
 *    it appears in the matrix, an operator grants it, and no code path is any different
 *
 * The second is how this test found that six abilities have been granted and unchecked since the
 * config was written. They are named in `NOT_YET_ENFORCED` and marked in the matrix rather than
 * quietly removed.
 */

/**
 * Every ability string in the codebase, excluding the registry's own declaration of it.
 *
 * Excluding the registry is what makes both directions readable: with it included, an ability
 * appears at least once by definition and "mentioned nowhere else" cannot be told from "mentioned
 * once here".
 */
function mentions(): string
{
    static $haystack = null;

    if ($haystack !== null) {
        return $haystack;
    }

    $registry = 'app/Support/Auth/EmployeeAbilities.php';
    $haystack = '';

    foreach (['app', 'resources/js', 'packages'] as $dir) {
        foreach (File::allFiles(base_path($dir)) as $file) {
            if (! in_array($file->getExtension(), ['php', 'ts', 'tsx'], true)) {
                continue;
            }

            // Compared on the tail rather than the whole path: `getPathname()` uses the platform
            // separator and `base_path()` does not, so an equality check excluded nothing on
            // Windows — and the registry's own declaration then counted as a mention of every
            // ability in it, which made the staleness check report all six as enforced.
            if (str_ends_with(strtr($file->getPathname(), '\\', '/'), $registry)) {
                continue;
            }

            $haystack .= File::get($file->getPathname());
        }
    }

    return $haystack;
}

it('registers every ability the shipping config grants', function (): void {
    $configured = [];

    foreach ((array) config('pos.role_abilities', []) as $abilities) {
        foreach ((array) $abilities as $ability) {
            $configured[(string) $ability] = true;
        }
    }

    $missing = array_values(array_filter(
        array_keys($configured),
        static fn (string $ability): bool => ! EmployeeAbilities::exists($ability),
    ));

    expect($missing)->toBe([], 'config/pos.php grants abilities the registry does not know: '
        .implode(', ', $missing).'. A venue upgrading would silently lose them, because'
        .' `abilitiesFor()` filters through the registry on the way out.');
});

it('does not list an ability no source file mentions', function (): void {
    // Deliberately a *mention*, not a check: an ability travels from the register's own gate to the
    // server through several layers and appears in different shapes on the way — a constant, a map
    // key, an `ability` field on a request. Grepping for the literal is what all of those share.
    //
    // So this catches the case that matters — an ability nobody has written down anywhere, which is
    // a typo in the registry itself — and would not catch one mentioned but never acted on. Naming
    // that limit is more useful than a stricter test that fails whenever the register refactors.
    $haystack = mentions();

    $orphans = array_values(array_filter(
        EmployeeAbilities::all(),
        static fn (string $ability): bool => ! str_contains($haystack, "'".$ability."'")
            // Except the six already known to be granted and unchecked, which the registry names and
            // the matrix marks. Finding a *new* one is what this catches.
            && EmployeeAbilities::isEnforced($ability),
    ));

    expect($orphans)->toBe([], 'the registry lists abilities nothing else mentions: '
        .implode(', ', $orphans).'. They would appear in the matrix as grantable permissions that'
        .' change nothing — either enforce them, or add them to `NOT_YET_ENFORCED` so the matrix'
        .' says so.');
});

it('does not excuse an ability that is in fact enforced', function (): void {
    // The exemption list is the kind that grows quietly and then hides a real regression. An ability
    // marked unenforced that the code *does* check would mark a working permission as doing nothing,
    // which is the same lie in the other direction — and the one that would follow from someone
    // wiring up `receipt.print` and not knowing to come back here.
    $haystack = mentions();

    $stale = array_values(array_filter(
        EmployeeAbilities::unenforced(),
        static fn (string $ability): bool => str_contains($haystack, "'".$ability."'"),
    ));

    expect($stale)->toBe([], 'these are marked as not yet enforced and something now checks them: '
        .implode(', ', $stale).'. Take them off the list.');
});

it('finds the abilities at all, so a passing run means something', function (): void {
    // The guard on the guard. If the registry were empty or the config key renamed, the checks above
    // would pass by having nothing to compare.
    expect(count(EmployeeAbilities::all()))->toBeGreaterThan(20)
        ->and((array) config('pos.role_abilities.manager'))->not->toBeEmpty()
        // And the haystack has to actually contain abilities, or "mentioned nowhere" is vacuous.
        ->and(mentions())->toContain("'order.void_paid'");
});
