<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\FiscalPositionCrud;

use App\Models\Pos\PosConfig;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\FiscalPositionTax;
use App\Models\Pricing\Tax;
use App\Support\Tax\Dto\FiscalPosition as FiscalPositionDto;
use App\Support\Tax\FiscalPositionMapper;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Fiscal positions and their tax mappings (BOF-036, BAN-398).
 *
 * A fiscal position rewrites which tax applies — takeaway VAT is the everyday case, and the
 * difference is the tax authority's money either way. `FiscalPositionMapper` has implemented and
 * tested that rewriting since it was written and the register applies a position correctly the
 * moment one exists. There was no way to create one: no route, no controller, no page.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view', 'catalog.manage_taxes'));
});

/** @param array<string, mixed> $payload */
function addPosition(array $payload = []): TestResponse
{
    return test()->post('/fiscal-positions', ['name' => 'À emporter', ...$payload]);
}

function ourPosition(): FiscalPosition
{
    return FiscalPosition::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => 'À emporter',
    ]);
}

function anotherTax(string $name, string $amount): Tax
{
    return Tax::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'tax_group_id' => test()->fx->tax->tax_group_id,
        'name' => $name,
        'amount' => $amount,
        'amount_type' => 'percent',
    ]);
}

it('adds a fiscal position', function (): void {
    addPosition()->assertSessionHasNoErrors()->assertRedirect();

    expect(FiscalPosition::query()->where('name', 'À emporter')->exists())->toBeTrue();
});

it('maps one tax onto another', function (): void {
    $position = ourPosition();
    $takeaway = anotherTax('TVA 5,5 %', '5.5000');

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $takeaway->getKey(),
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect(FiscalPositionTax::query()
        ->where('fiscal_position_id', $position->getKey())
        ->where('tax_src_id', $this->fx->tax->getKey())
        ->value('tax_dest_id'))->toBe((int) $takeaway->getKey());
});

it('maps a tax onto nothing, which is what exempt means', function (): void {
    // `tax_dest_id` is nullable on purpose. An export or exempt regime removes the tax entirely,
    // and that has to be a first-class choice rather than an unfinished row.
    $position = ourPosition();

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => null,
    ])->assertSessionHasNoErrors()->assertRedirect();

    $mapping = FiscalPositionTax::query()
        ->where('fiscal_position_id', $position->getKey())
        ->first();

    expect($mapping)->not->toBeNull()
        ->and($mapping->tax_dest_id)->toBeNull();
});

it('refuses a tax mapped onto itself', function (): void {
    // It changes nothing, and an operator who does it is trying to express something else —
    // probably "remove this tax", which is the empty destination.
    $position = ourPosition();

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $this->fx->tax->getKey(),
    ])->assertSessionHasErrors('tax_dest_id');
});

it('refuses a second mapping for the same source tax', function (): void {
    // The unique index covers (position, src, dest), so a second row for the same source with a
    // *different* destination passes the database and then reads as ambiguous: one tax cannot
    // become two different things at once.
    $position = ourPosition();
    $five = anotherTax('TVA 5,5 %', '5.5000');
    $ten = anotherTax('TVA 10 %', '10.0000');

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $five->getKey(),
    ])->assertSessionHasNoErrors();

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $ten->getKey(),
    ])->assertSessionHasErrors('tax_src_id');

    expect(FiscalPositionTax::query()->where('fiscal_position_id', $position->getKey())->count())->toBe(1);
});

it('refuses another venue tax in a mapping', function (): void {
    $position = ourPosition();

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->other->tax->getKey(),
    ])->assertSessionHasErrors('tax_src_id');
});

it('does not let a mapping be reached through the wrong position', function (): void {
    $ours = ourPosition();
    $second = FiscalPosition::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Export',
    ]);

    $mapping = $second->taxMappings()->create([
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => null,
    ]);

    test()->delete("/fiscal-positions/{$ours->getKey()}/mappings/{$mapping->getKey()}")
        ->assertNotFound();

    expect(FiscalPositionTax::query()->whereKey($mapping->getKey())->exists())->toBeTrue();
});

it('does not touch another venue position', function (): void {
    $theirs = FiscalPosition::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'La leur',
    ]);

    test()->patch("/fiscal-positions/{$theirs->getKey()}", ['name' => 'Mienne'])->assertNotFound();
});

it('refuses to remove a position that has taxed orders', function (): void {
    // Those orders are history and must keep naming the regime they were taxed under.
    $position = ourPosition();
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'fiscal_position_id' => $position->getKey(),
        'tracking_number' => 'T-1',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete("/fiscal-positions/{$position->getKey()}")->assertSessionHasErrors('position');

    expect(FiscalPosition::query()->whereKey($position->getKey())->exists())->toBeTrue();
});

it('refuses to remove a position a register defaults to', function (): void {
    $position = ourPosition();

    PosConfig::query()->whereKey($this->fx->config->getKey())
        ->update(['default_fiscal_position_id' => $position->getKey()]);

    test()->delete("/fiscal-positions/{$position->getKey()}")->assertSessionHasErrors('position');
});

it('removes one nothing points at', function (): void {
    $position = ourPosition();

    test()->delete("/fiscal-positions/{$position->getKey()}")->assertSessionHasNoErrors()->assertRedirect();

    expect(FiscalPosition::query()->whereKey($position->getKey())->exists())->toBeFalse();
});

it('refuses everything to someone who may only look at taxes', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access', 'catalog.view'));

    addPosition(['name' => 'Pas la mienne'])->assertForbidden();

    expect(FiscalPosition::query()->where('name', 'Pas la mienne')->exists())->toBeFalse();
});

it('actually rewrites the tax the register charges', function (): void {
    // The point of the whole surface. `FiscalPositionMapper` has done this correctly since it was
    // written — what was missing was any way to give it a position to work from.
    $position = ourPosition();
    $takeaway = anotherTax('TVA 5,5 %', '5.5000');

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $takeaway->getKey(),
    ])->assertRedirect();

    // Through the DTO, built the way `OrderInput::fromArray` builds it from wire data — that is the
    // seam this ticket is about, and the mapper itself was never wrong.
    $dto = FiscalPositionDto::fromArray([
        'id' => (int) $position->getKey(),
        'name' => (string) $position->name,
        'mappings' => FiscalPositionTax::query()
            ->where('fiscal_position_id', $position->getKey())
            ->get()
            ->map(static fn (FiscalPositionTax $m): array => [
                'taxSrcId' => (int) $m->tax_src_id,
                'taxDestId' => $m->tax_dest_id === null ? null : (int) $m->tax_dest_id,
            ])->all(),
    ]);

    expect(app(FiscalPositionMapper::class)->map([(int) $this->fx->tax->getKey()], $dto))
        ->toBe([(int) $takeaway->getKey()]);
});

it('removes the tax entirely when the mapping says so', function (): void {
    $position = ourPosition();

    test()->post("/fiscal-positions/{$position->getKey()}/mappings", [
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => null,
    ])->assertRedirect();

    $dto = FiscalPositionDto::fromArray([
        'id' => (int) $position->getKey(),
        'mappings' => [['taxSrcId' => (int) $this->fx->tax->getKey(), 'taxDestId' => null]],
    ]);

    expect(app(FiscalPositionMapper::class)->map([(int) $this->fx->tax->getKey()], $dto))->toBe([]);
});
