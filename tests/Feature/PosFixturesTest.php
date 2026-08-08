<?php

declare(strict_types=1);

// Own namespace so the helper below stays out of the global function table Pest shares across every
// test file.

namespace Tests\Feature\PosFixturesProperties;

use App\Models\Identity\Company;
use App\Models\Pricing\Currency;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-508 — the fixture's own contract.
 *
 * `PosFixtures::make()` twice is how every cross-tenant test is written, and it used to produce two
 * venues identical in everything but their ids. An assertion that venue A cannot see venue B's data
 * then compares a string against itself and passes whether the boundary holds or not.
 *
 * That is not theoretical. The probe that found the BAN-420 name disclosure reported a leak on its
 * first run — and would have reported one against correct code, because both venues' managers were
 * called "Karim M.". It only became evidence after renaming one by hand.
 *
 * Tests of a test fixture are unusual and this one earns its place: everything the tenancy suite
 * proves rests on the two venues being distinguishable.
 */

/** Every name a test might reasonably assert against. */
function names(PosFixtures $fx): array
{
    return [
        'company' => $fx->company->name,
        'config' => $fx->config->name,
        'cashier' => $fx->cashier->name,
        'manager' => $fx->manager->name,
        'product' => $fx->product->name,
        'drink' => $fx->drink->name,
        'category' => $fx->category->name,
        'tax' => $fx->tax->name,
        'cash_method' => $fx->cash->name,
        'card_method' => $fx->card->name,
        'device' => $fx->device->name,
    ];
}

it('gives two venues no name in common', function (): void {
    $mine = names(PosFixtures::make());
    $theirs = names(PosFixtures::make());

    $shared = array_keys(array_filter(
        $mine,
        static fn (string $name, string $key): bool => $theirs[$key] === $name,
        ARRAY_FILTER_USE_BOTH,
    ));

    expect($shared)->toBe([], 'Both venues use these names, so a comparison between them proves nothing: '
        .implode(', ', $shared));
});

it('leaves the first venue named exactly as it always was', function (): void {
    // The other half of the contract, and the reason the suffix is empty rather than ' #1': roughly
    // forty tests assert on `Margherita` and friends, and none of them should have had to change.
    $fx = PosFixtures::make();

    expect($fx->company->name)->toBe('Trattoria Test')
        ->and($fx->config->name)->toBe('Bar')
        ->and($fx->cashier->name)->toBe('Amina B.')
        ->and($fx->manager->name)->toBe('Karim M.')
        ->and($fx->product->name)->toBe('Margherita')
        ->and($fx->drink->name)->toBe('Sparkling water')
        ->and($fx->suffix)->toBe('');
});

it('distinguishes a third venue from the first two', function (): void {
    $names = array_map(static fn (PosFixtures $fx): string => $fx->company->name, [
        PosFixtures::make(), PosFixtures::make(), PosFixtures::make(),
    ]);

    expect(array_unique($names))->toHaveCount(3);
});

it('numbers venues from the table, so each test starts over', function (): void {
    // Counted from the table rather than from a static: a static keeps climbing across tests in one
    // process, so the *first* venue of the second test would arrive suffixed — the one thing that
    // must not happen. `RefreshDatabase` resets the count for free.
    expect(PosFixtures::make()->suffix)->toBe('')
        ->and(PosFixtures::make()->suffix)->toBe(' #2');
});

it('gives no venue a category path that prefixes another', function (): void {
    // `pos_categories.path` is matched with `LIKE path%` in three places, so a trailing marker makes
    // `/Food` a prefix of `/Food #2` and a subtree query rooted at the first venue reaches into the
    // second — asymmetrically, which is harder to spot than the identical paths it replaced.
    $mine = PosFixtures::make();
    $theirs = PosFixtures::make();

    foreach ([$mine, $theirs] as $fx) {
        $reached = DB::table('pos_categories')->where('path', 'like', $fx->category->path.'%')->count();

        expect($reached)->toBe(1, "A subtree query from {$fx->category->path} reached {$reached} categories.");
    }
});

it('is not thrown off by a company it did not create', function (): void {
    // The ordinal counts the venues this fixture built, not `companies` at large. Otherwise a test
    // that makes a company of its own first pushes the *first* venue to ` #2`, and an assertion on
    // `Margherita` fails for a reason three lines away and nothing to do with it.
    Company::query()->create([
        'name' => 'Somebody Else Ltd',
        'currency_id' => Currency::query()->create([
            'code' => 'ZZZ', 'name' => 'Zed', 'symbol' => 'Z',
            'decimal_places' => 2, 'rounding' => 0.01, 'active' => true,
        ])->getKey(),
        'timezone' => 'UTC',
    ]);

    $fx = PosFixtures::make();

    expect($fx->suffix)->toBe('')
        ->and($fx->product->name)->toBe('Margherita');
});

it('names a session the way the application would', function (): void {
    // `SessionService::nextName` strips punctuation, so a hardcoded `Bar #2/00001` is a name the
    // app could never mint — and a test comparing a generated name against the fixture's would be
    // confused by the mismatch rather than by anything real.
    PosFixtures::make();
    $second = PosFixtures::make()->withSession();

    $asBuilt = sprintf(
        '%s/%05d',
        preg_replace('/[^A-Za-z0-9]/', '', (string) $second->config->name) ?: 'POS',
        1,
    );

    expect($second->session->name)->toBe($asBuilt);
});

it('keeps the tables of two venues apart as well', function (): void {
    // Floors and tables are built on demand, so they take the suffix by the same route.
    $mine = PosFixtures::make()->withFloor();
    $theirs = PosFixtures::make()->withFloor();

    expect($theirs->floor->name)->not->toBe($mine->floor->name)
        ->and($theirs->tableOne->name)->not->toBe($mine->tableOne->name);
});
