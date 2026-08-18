<?php

declare(strict_types=1);

namespace Tests\Feature\Sync\OwnedReferences;

use App\Models\Pos\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

function pricelistFor(PosFixtures $fx, string $name): int
{
    return (int) DB::table('pricelists')->insertGetId([
        'company_id' => $fx->company->getKey(),
        'currency_id' => (int) DB::table('currencies')->value('id'),
        'name' => $name,
        'sequence' => 10,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function fiscalPositionFor(PosFixtures $fx, string $name): int
{
    return (int) DB::table('fiscal_positions')->insertGetId([
        'company_id' => $fx->company->getKey(),
        'name' => $name,
        'auto_apply' => false,
        'vat_required' => false,
        'sequence' => 10,
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/** Map this venue's tax to nothing — an exemption, which is the mapping that moves the most money. */
function exempt(int $fiscalPositionId, int $taxId): void
{
    DB::table('fiscal_position_taxes')->insert([
        'fiscal_position_id' => $fiscalPositionId,
        'tax_src_id' => $taxId,
        'tax_dest_id' => null,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function push(PosFixtures $fx, string $uuid, array $attributes): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create',
            'uuid' => (string) Str::uuid(),
            'variant_id' => $fx->variant->getKey(),
            'qty' => '1',
            'price_unit' => '100.00',
            'discount' => '0',
        ]], $attributes)],
    ]);
}

/**
 * BAN-520 — the last two client-supplied foreign keys on an order command.
 *
 * `customer_id` has been ownership-checked since REG-153, `pos_preset_id` since BAN-485 and
 * `restaurant_table_id` since BAN-471. These two were what remained, and unlike the preset — which
 * only ever produced a label — they touch money.
 */
it('drops another company fiscal position rather than taxing the sale by their rules', function (): void {
    // `OrderCalculator::fiscalPosition()` loads `fiscal_position_taxes` by id and scopes it to
    // nothing, so a crafted id applies another tenant's tax mapping to this venue's sale. Probed
    // before the fix: `ok`, with the foreign id persisted on our order.
    $other = PosFixtures::make()->withSession();
    $foreign = fiscalPositionFor($other, 'RIVAL TAX');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['fiscal_position_id' => $foreign])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->value('fiscal_position_id'))->toBeNull();
});

it('keeps the tax the venue actually charges when a foreign exemption is named', function (): void {
    // The money, not just the column. Their fiscal position maps our 21 % tax to nothing, so if it
    // were applied the VAT on a legally-weighted document would come out zero.
    $other = PosFixtures::make()->withSession();
    $foreign = fiscalPositionFor($other, 'RIVAL EXEMPTION');
    exempt($foreign, (int) $this->fx->tax->getKey());

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['fiscal_position_id' => $foreign])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((float) $order->amount_tax)->toBeGreaterThan(0.0);
});

it('honours the venue own exemption, so the guard is not simply ignoring the field', function (): void {
    // The control for the test above: the same mapping, owned by this company, must still apply.
    // Without this pair, a guard that dropped *every* fiscal position would look correct.
    $mine = fiscalPositionFor($this->fx, 'Export');
    exempt($mine, (int) $this->fx->tax->getKey());

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['fiscal_position_id' => $mine])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((int) $order->fiscal_position_id)->toBe($mine)
        ->and((float) $order->amount_tax)->toBe(0.0);
});

it('accepts the sale when a foreign pricelist is named instead of losing it', function (): void {
    // This one never leaked — `PricelistResolver` only holds the pricelists this config loaded and
    // throws on anything else. It did something worse: the throw becomes `ingest_failed`, the client
    // treats a rejection as permanent, and the outbox quarantines the push. A stale id left on a
    // device after a pricelist is unlinked needs no attacker at all, and the sale is gone.
    //
    // Probed before the fix: `rejected`, `ingest_failed`, "unknown pricelist 1".
    $other = PosFixtures::make()->withSession();
    $foreign = pricelistFor($other, 'RIVAL PRICES');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['pricelist_id' => $foreign])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    // Priced off the register's own default, which is what an order with no pricelist has always
    // done — the sale survives.
    expect(Order::query()->where('uuid', $uuid)->value('pricelist_id'))
        ->toBe($this->fx->config->pricelist_id);
});

it('leaves this company own pricelist alone', function (): void {
    $mine = pricelistFor($this->fx, 'Happy hour');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['pricelist_id' => $mine])->assertOk();

    expect((int) Order::query()->where('uuid', $uuid)->value('pricelist_id'))->toBe($mine);
});

it('guards the update path too, not only the create', function (): void {
    // Both paths write these columns from the same client keys, which is why the check sits at the
    // batch chokepoint rather than beside either one. A guard on create alone leaves the second
    // push — the one every outbox retry makes — wide open.
    $other = PosFixtures::make()->withSession();
    $foreign = fiscalPositionFor($other, 'RIVAL TAX');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, [])->assertOk();

    push($this->fx, $uuid, ['fiscal_position_id' => $foreign])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect(Order::query()->where('uuid', $uuid)->value('fiscal_position_id'))->toBeNull();
});

it('never clears a good value the order already had (review of #72)', function (): void {
    // The first version of this guard set the unusable id to null. On create that is identical to
    // dropping it — `??` falls through to the register's default either way. On update it is not:
    // the writable loop writes any key that is *present*, so the null landed on the column and wiped
    // it.
    //
    // In service that reads as: a bill correctly configured for an export exemption, one stale or
    // tampered push later, silently re-taxed at the standard rate. The guard ignores the field now
    // rather than answering it.
    $other = PosFixtures::make()->withSession();
    $mine = fiscalPositionFor($this->fx, 'Export');
    $theirs = fiscalPositionFor($other, 'RIVAL');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['fiscal_position_id' => $mine])->assertOk();

    push($this->fx, $uuid, ['fiscal_position_id' => $theirs])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    expect((int) Order::query()->where('uuid', $uuid)->value('fiscal_position_id'))->toBe($mine);
});

it('never clears a good pricelist either', function (): void {
    $other = PosFixtures::make()->withSession();
    $mine = pricelistFor($this->fx, 'Happy hour');
    $theirs = pricelistFor($other, 'RIVAL PRICES');

    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, ['pricelist_id' => $mine])->assertOk();
    push($this->fx, $uuid, ['pricelist_id' => $theirs])->assertOk();

    expect((int) Order::query()->where('uuid', $uuid)->value('pricelist_id'))->toBe($mine);
});

it('leaves an order naming neither field on the register defaults', function (): void {
    $uuid = (string) Str::uuid();
    push($this->fx, $uuid, [])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect($order->pricelist_id)->toBe($this->fx->config->pricelist_id)
        ->and($order->fiscal_position_id)->toBe($this->fx->config->default_fiscal_position_id);
});
