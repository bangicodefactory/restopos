<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\BarcodeNomenclature;

use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Catalog\BarcodeRule;
use App\Models\Pos\PosConfig;
use App\Models\Scopes\CompanyScope;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * How a venue reads the barcodes on its own shelves (BOF-043, BAN-488).
 *
 * A supermarket that prints weight into an EAN-13 — `21`, then the product code, then the grams —
 * needs a rule saying which digits are which, or every scan of a weighed item is a miss or the
 * wrong product at the wrong price. The tables, models and enums have existed since the catalogue
 * schema was written; there was no route, no controller and no page, so rules could only be seeded.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view', 'catalog.manage_products'));
});

/** @param array<string, mixed> $payload */
function addNomenclature(array $payload = []): TestResponse
{
    return test()->post('/barcode-nomenclatures', ['name' => 'Poids embarqué', ...$payload]);
}

function ourNomenclature(): BarcodeNomenclature
{
    return BarcodeNomenclature::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => 'Poids embarqué',
    ]);
}

it('adds a nomenclature', function (): void {
    addNomenclature()->assertSessionHasNoErrors()->assertRedirect();

    expect(BarcodeNomenclature::query()->where('name', 'Poids embarqué')->exists())->toBeTrue();
});

it('adds a weight rule to it', function (): void {
    $n = ourNomenclature();

    test()->post("/barcode-nomenclatures/{$n->getKey()}/rules", [
        'name' => 'Poids 21',
        'rule_type' => 'weight',
        'pattern' => '21.....{NNDDD}',
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(BarcodeRule::query()->where('barcode_nomenclature_id', $n->getKey())->count())->toBe(1);
});

it('refuses a pattern that is not a pattern', function (): void {
    // The pattern is read as a regular expression by the client. A free string here is a rule that
    // either never matches or matches everything, and the operator finds out at the till.
    $n = ourNomenclature();

    test()->post("/barcode-nomenclatures/{$n->getKey()}/rules", [
        'name' => 'Bancale',
        'rule_type' => 'weight',
        'pattern' => 'drop table products',
    ])->assertSessionHasErrors('pattern');
});

it('refuses a rule type the check constraint would reject', function (): void {
    // The column carries a CHECK. Without a rule this is a 500 rather than a 422.
    $n = ourNomenclature();

    test()->post("/barcode-nomenclatures/{$n->getKey()}/rules", [
        'name' => 'Inventé',
        'rule_type' => 'teleport',
        'pattern' => '21.....',
    ])->assertSessionHasErrors('rule_type');
});

it('orders new rules after the ones already there', function (): void {
    // Order decides which rule wins on a barcode two of them match, so a new rule appended at the
    // end is the only safe default — inserting one at the front silently re-reads existing labels.
    $n = ourNomenclature();

    foreach (['A', 'B'] as $name) {
        test()->post("/barcode-nomenclatures/{$n->getKey()}/rules", [
            'name' => $name,
            'rule_type' => 'weight',
            'pattern' => '21.....',
        ])->assertRedirect();
    }

    $sequences = BarcodeRule::query()
        ->where('barcode_nomenclature_id', $n->getKey())
        ->orderBy('id')
        ->pluck('sequence')
        ->all();

    expect($sequences[1])->toBeGreaterThan($sequences[0]);
});

it('does not touch another venue nomenclature', function (): void {
    $theirs = BarcodeNomenclature::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'La leur',
    ]);

    test()->patch("/barcode-nomenclatures/{$theirs->getKey()}", ['name' => 'Mienne'])
        ->assertNotFound();

    // Read back without the scope: `BarcodeNomenclature::query()` would not see the other venue's
    // row at all, so the assertion would pass on an empty string rather than on the real name.
    expect((string) BarcodeNomenclature::query()
        ->withoutGlobalScope(CompanyScope::class)
        ->whereKey($theirs->getKey())
        ->value('name'))->toBe('La leur');
});

it('refuses to edit a nomenclature shared by every venue', function (): void {
    // `company_id` is nullable because the standard EAN-13 and UPC-A nomenclatures are the same
    // everywhere and ship as global rows. Editing one would change what every venue on the instance
    // scans, which is not a thing one venue's manager may do — however privileged.
    $shared = BarcodeNomenclature::query()->create(['company_id' => null, 'name' => 'EAN-13 standard']);

    test()->patch("/barcode-nomenclatures/{$shared->getKey()}", ['name' => 'Détourné'])
        ->assertSessionHasErrors('nomenclature');

    expect((string) BarcodeNomenclature::query()
        ->withoutGlobalScope(CompanyScope::class)
        ->whereKey($shared->getKey())
        ->value('name'))->toBe('EAN-13 standard');
});

it('still shows a shared nomenclature, because a venue may use one', function (): void {
    $this->withoutVite();

    BarcodeNomenclature::query()->create(['company_id' => null, 'name' => 'EAN-13 standard']);

    $this->get('/barcode-nomenclatures')
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'nomenclatures',
            fn ($rows): bool => collect($rows)->contains(
                fn (array $row): bool => $row['name'] === 'EAN-13 standard' && $row['is_shared'] === true,
            ),
        ));
});

it('refuses to remove one a register still points at', function (): void {
    // `fallback_barcode_nomenclature_id` is `nullOnDelete`, so the database would let this through
    // and blank the register — every weighed-item scan on that till would start missing, with
    // nothing on any screen connecting the two events.
    $n = ourNomenclature();

    PosConfig::query()->whereKey($this->fx->config->getKey())
        ->update(['fallback_barcode_nomenclature_id' => $n->getKey()]);

    test()->delete("/barcode-nomenclatures/{$n->getKey()}")->assertSessionHasErrors('nomenclature');

    expect(BarcodeNomenclature::query()->whereKey($n->getKey())->exists())->toBeTrue();
});

it('removes one nothing points at', function (): void {
    $n = ourNomenclature();

    test()->delete("/barcode-nomenclatures/{$n->getKey()}")->assertSessionHasNoErrors()->assertRedirect();

    expect(BarcodeNomenclature::query()->whereKey($n->getKey())->exists())->toBeFalse();
});

it('lets a register be pointed at a nomenclature', function (): void {
    $n = ourNomenclature();

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'fallback_barcode_nomenclature_id' => $n->getKey(),
    ])->assertSessionHasNoErrors();

    expect((int) PosConfig::query()->whereKey($this->fx->config->getKey())
        ->value('fallback_barcode_nomenclature_id'))->toBe((int) $n->getKey());
});

it('lets a register be pointed at a shared nomenclature', function (): void {
    // The whole reason the column is nullable: a venue using plain EAN-13 uses the global row.
    $shared = BarcodeNomenclature::query()->create(['company_id' => null, 'name' => 'EAN-13 standard']);

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'fallback_barcode_nomenclature_id' => $shared->getKey(),
    ])->assertSessionHasNoErrors();

    expect((int) PosConfig::query()->whereKey($this->fx->config->getKey())
        ->value('fallback_barcode_nomenclature_id'))->toBe((int) $shared->getKey());
});

it('refuses to point a register at another venue nomenclature', function (): void {
    $theirs = BarcodeNomenclature::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'La leur',
    ]);

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'fallback_barcode_nomenclature_id' => $theirs->getKey(),
    ])->assertSessionHasErrors('fallback_barcode_nomenclature_id');
});

it('refuses a rule from someone who may only look', function (): void {
    $n = ourNomenclature();

    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view'));

    test()->post("/barcode-nomenclatures/{$n->getKey()}/rules", [
        'name' => 'Pas la mienne',
        'rule_type' => 'weight',
        'pattern' => '21.....',
    ])->assertForbidden();
});

it('does not let a rule be moved between nomenclatures by URL', function (): void {
    $ours = ourNomenclature();
    $second = BarcodeNomenclature::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Autre',
    ]);

    $rule = $second->rules()->create([
        'name' => 'Ailleurs',
        'rule_type' => 'weight',
        'pattern' => '21.....',
    ]);

    test()->delete("/barcode-nomenclatures/{$ours->getKey()}/rules/{$rule->getKey()}")
        ->assertNotFound();

    expect(BarcodeRule::query()->whereKey($rule->getKey())->exists())->toBeTrue();
});

// ───────────────────────────────────────── the back office's half of the contract

it('ships a rule authored here in the shape the parser reads', function (): void {
    // The join the ticket names: a rule an operator authors must reach the till in a shape
    // `packages/domain/src/barcode` understands. The parser lives once and both the register and the
    // back-office rule tester call it, so what has never been asserted is not the parsing — it is
    // that the *fields* survive the trip.
    //
    // `tests/fixtures/barcode/nomenclature-parity.json` holds both halves. This authors its rules
    // through the real endpoint and asserts the bootstrap payload matches field for field;
    // `packages/domain/test/barcode/nomenclature.parity.test.ts` asserts what the parser then makes
    // of them. Either side drifting fails one of the two.
    $fixture = json_decode(
        (string) file_get_contents(base_path('tests/fixtures/barcode/nomenclature-parity.json')),
        true,
    );

    expect($fixture['rules'])->not->toBeEmpty('the shared fixture corpus must be readable');

    addNomenclature([
        'name' => $fixture['nomenclature']['name'],
        'upc_ean_conv' => $fixture['nomenclature']['upc_ean_conv'],
        'is_gs1' => $fixture['nomenclature']['is_gs1'],
    ])->assertSessionHasNoErrors();

    $nomenclature = BarcodeNomenclature::query()
        ->where('name', $fixture['nomenclature']['name'])
        ->firstOrFail();

    foreach ($fixture['rules'] as $rule) {
        test()->post("/barcode-nomenclatures/{$nomenclature->getKey()}/rules", [
            'name' => $rule['name'],
            'rule_type' => $rule['rule_type'],
            'pattern' => $rule['pattern'],
            'encoding' => $rule['encoding'],
            'alias' => $rule['alias'],
            'sequence' => $rule['sequence'],
        ])->assertSessionHasNoErrors();
    }

    // Authoring is not selecting. Only the nomenclature a company or a register points at is
    // shipped, so a rule set left unattached reaches no till at all — see the test below.
    $this->fx->config->forceFill(['fallback_barcode_nomenclature_id' => $nomenclature->getKey()])->save();

    $payload = test()->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')->assertOk()->json();

    $shipped = collect($payload['data']['barcode_rules'] ?? [])
        ->where('barcode_nomenclature_id', $nomenclature->getKey())
        ->sortBy('sequence')
        ->values();

    expect($shipped)->toHaveCount(count($fixture['rules']));

    // Both sides in resolution order. The fixture lists its rules in the order they read best; the
    // parser walks them by `sequence`, and so does the assertion — comparing declaration order
    // against resolution order would fail on a fixture that is perfectly correct.
    $expectedRules = collect($fixture['rules'])->sortBy('sequence')->values();

    foreach ($expectedRules as $i => $expected) {
        // Every field the parser reads. `id` and `barcode_nomenclature_id` are the venue's own and
        // are deliberately not compared — the fixture numbers them 1..3 for the TypeScript side,
        // and asserting them here would be asserting the autoincrement.
        foreach (['name', 'rule_type', 'pattern', 'encoding', 'alias', 'sequence'] as $field) {
            expect($shipped[$i][$field] ?? null)->toBe(
                $expected[$field],
                "rule {$i} field {$field} must reach the till unchanged",
            );
        }
    }
});

it('ships the nomenclature fields the parser gates on', function (): void {
    // `upc_ean_conv` decides which alternative codes are worth trying and `is_gs1` decides whether a
    // scan is read as a GS1 composite before any rule is consulted. A rule set that arrives without
    // them parses differently from the one the operator authored.
    addNomenclature(['name' => 'Rayon pesée', 'upc_ean_conv' => 'always', 'is_gs1' => false])
        ->assertSessionHasNoErrors();

    $this->fx->config->forceFill([
        'fallback_barcode_nomenclature_id' => BarcodeNomenclature::query()
            ->where('name', 'Rayon pesée')->value('id'),
    ])->save();

    $payload = test()->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')->assertOk()->json();

    $shipped = collect($payload['data']['barcode_nomenclatures'] ?? [])
        ->firstWhere('name', 'Rayon pesée');

    expect($shipped)->not->toBeNull()
        ->and($shipped['upc_ean_conv'])->toBe('always')
        ->and((bool) $shipped['is_gs1'])->toBeFalse();
});

it('does not ship a nomenclature no register was pointed at', function (): void {
    // The other half, and the trap: authoring a rule set is not selecting one. A venue that writes
    // its weight rules and never attaches them scans exactly as it did before, with a screen full of
    // correct-looking rules to explain why it should have worked.
    addNomenclature(['name' => 'Jamais choisie'])->assertSessionHasNoErrors();

    $payload = test()->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')->assertOk()->json();

    expect(collect($payload['data']['barcode_nomenclatures'] ?? [])->pluck('name'))
        ->not->toContain('Jamais choisie');
});
