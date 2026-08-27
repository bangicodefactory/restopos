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
