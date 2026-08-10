<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\StalePriceWriteOff;

use App\Enums\OrderState;
use App\Enums\SpecialKind;
use App\Models\Audit\AuditLog;
use App\Models\Catalog\Product;
use App\Models\Pos\Order;
use App\Models\Pos\PosSession;
use App\Services\Pos\AccountingExportService;
use App\Support\Audit\AuditEvent;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-514 — the money BAN-502's repricing leaves on the table.
 *
 * BAN-502 made the server the price authority: the till's `price_unit` is a proposal, the catalogue
 * decides. That is right and it stays right. But the till has already taken the customer's money at
 * whatever price it displayed, and on a stale catalogue those two disagree. Repricing then leaves
 * the order permanently short — and because `session_sales_summaries` freeze the *server's* total
 * while `session_payment_totals` freeze what was actually tendered, the difference reappears at the
 * far end of the chain as an unexplained `imbalance_amount` on the accounting export.
 *
 * The drawer was never wrong: `expected_cash` comes from the payment rows, so the cash count
 * reconciles either way. It is the ledger that stops adding up, which is the one thing an export
 * exists to do.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/** Move the catalogue out from under the till, exactly as an offline price change does. */
function repriceCatalogue(PosFixtures $fx, string $price): void
{
    $fx->product->forceFill(['list_price' => $price])->save();
    $fx->variant->forceFill(['list_price' => $price])->save();
}

/**
 * A settled sale for one unit: the till charged `$charged`, declared that as its total, and took
 * exactly `$tendered` for it.
 */
function settleAtStalePrice(
    PosFixtures $fx,
    string $uuid,
    string $charged,
    string $clientTotal,
    string $tendered,
): TestResponse {
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $fx->orderCommand(
            $uuid,
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => $charged, 'discount' => '0',
            ]],
            ['state' => OrderState::Paid->value, 'amount_total_client' => $clientTotal],
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $fx->cash->getKey(), 'amount' => $tendered,
            ]],
        ),
    ]]);
}

/** A variant whose product is `special_kind = tip` - a line the client prices, not the server. */
function tipVariantFor(PosFixtures $fx): int
{
    $product = Product::query()->where('company_id', $fx->company->getKey())->firstOrFail()->replicate(['uuid']);
    $product->uuid = (string) Str::uuid();
    $product->name = 'Pourboire';
    $product->special_kind = SpecialKind::Tip->value;
    $product->save();

    $variant = $fx->variant->replicate(['uuid']);
    $variant->uuid = (string) Str::uuid();
    $variant->product_id = $product->getKey();
    $variant->display_name = 'Pourboire';
    $variant->save();

    return (int) $variant->getKey();
}

// ── the order ────────────────────────────────────────────────────────────────

it('writes off what the repricing left uncollected', function (): void {
    // 10.00 on the till, 12.00 on the server, 21% on top: the order is worth 14.52 and 12.10 came
    // in. The 2.42 is not a debt — the customer paid what they were asked and left.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();

    settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '12.10')
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('14.5200')
        ->and((string) $order->amount_paid)->toBe('12.1000')
        ->and((string) $order->amount_write_off)->toBe('2.4200')
        ->and((string) $order->amount_due)->toBe('0.0000');
});

it('tells the device what it wrote off', function (): void {
    repriceCatalogue($this->fx, '12.00');

    $response = settleAtStalePrice($this->fx, (string) Str::uuid(), '10.00', '12.10', '12.10')->assertOk();

    $warning = collect((array) $response->json('results.0.warnings'))
        ->firstWhere('code', 'stale_price_written_off');

    expect($warning)->not->toBeNull()
        ->and($warning['amount'])->toBe('2.4200')
        // The delta is the server's own measure of what it changed, and the bound on the amount.
        ->and($warning['repricing_delta'])->toBe('2.4200')
        ->and($warning['server_total'])->toBe('14.5200');
});

it('does not write the same shortfall off twice', function (): void {
    // The register re-sends the whole order on every push, so this command arrives again as a
    // matter of course. Deciding the write-off afresh each time would compound it — and because
    // `recompute()` subtracts the column, the second pass would find a due of zero and add to a
    // total that was already right.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();
    settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '12.10')->assertOk();

    for ($i = 0; $i < 3; $i++) {
        test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
            $this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value, 'amount_total_client' => '12.10']),
        ]])->assertOk();
    }

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_write_off)->toBe('2.4200')
        ->and((string) $order->amount_due)->toBe('0.0000');
});

it('forgives only what the server own repricing added', function (): void {
    // The bound that keeps this from becoming "settled orders never owe anything". A till on a
    // stale price that also under-tendered is short on two counts: 2.42 of it is our pricing and
    // the rest is a genuine debt. Only the first is written off.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();
    settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '5.00')->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('14.5200')
        ->and((string) $order->amount_write_off)->toBe('2.4200')
        // 14.52 − 5.00 tendered − 2.42 forgiven.
        ->and((string) $order->amount_due)->toBe('7.1000');
});

it('forgives nothing on an order the server never repriced', function (): void {
    // The hole the first cut of this left, and the reason the bound is the server's own delta and
    // not `amount_total_client`. That field is an unvalidated assertion by the device.
    //
    // Nothing is stale here: the catalogue is correct and the server prices the order correctly at
    // 121.00. The device simply declares a total of 12.10 and tenders 12.10. Capped at the client's
    // declared total, the server forgave 108.90, marked the order settled, and the accounting
    // export *balanced* - BAN-502 stopped the device setting the price, and this let it set what it
    // owed instead, which is the same money by another route.
    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand(
            $uuid,
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                // Ten units at exactly the catalogue price - the server changes nothing.
                'qty' => '10', 'price_unit' => '10.00', 'discount' => '0',
            ]],
            ['state' => OrderState::Paid->value, 'amount_total_client' => '12.10'],
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '12.10',
            ]],
        ),
    ]])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('121.0000')
        ->and((string) $order->amount_write_off)->toBe('0.0000')
        ->and((string) $order->amount_due)->toBe('108.9000')
        ->and(AuditLog::query()->where('event', AuditEvent::StalePriceWrittenOff)->exists())->toBeFalse();
});

it('does not forgive a tip added after the sale was settled', function (): void {
    // The accumulation bound. The allowance is the delta *less what has already been forgiven*, and
    // without that a second push re-measures the full gap and spends it again. A tip is a line the
    // client is entitled to price, so it adds nothing to the delta - but the till re-sending its
    // original stale total made the gap look wide enough to cover it, and the whole 5.00 tip was
    // written off on top of the genuine 2.42.
    $fx = PosFixtures::make(['enable_tips' => true, 'tip_after_payment' => true])->withSession();
    repriceCatalogue($fx, '12.00');

    $uuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $fx->orderCommand(
            $uuid,
            [[
                'op' => 'create', 'uuid' => $lineUuid, 'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
            ]],
            ['state' => OrderState::Paid->value, 'amount_total_client' => '12.10'],
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $fx->cash->getKey(), 'amount' => '12.10',
            ]],
        ),
    ]])->assertOk();

    expect((string) Order::query()->where('uuid', $uuid)->value('amount_write_off'))->toBe('2.4200');

    // The whole graph comes back, as it does on every push, with a tip line joining it.
    $command = $fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value, 'amount_total_client' => '12.10']);
    $command['lines'] = [
        ['op' => 'update', 'uuid' => $lineUuid, 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => tipVariantFor($fx),
            'qty' => '1', 'price_unit' => '5.00', 'discount' => '0'],
    ];

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [$command]])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('19.5200')
        ->and((string) $order->amount_write_off)->toBe('2.4200')
        // The tip is money the customer agreed to and has not handed over. It stays owed.
        ->and((string) $order->amount_due)->toBe('5.0000');
});

it('nets a line the server priced down against one it priced up', function (): void {
    // The delta is signed. Two lines of the same product, the till proposing 8.00 on one and 14.00
    // on the other; the catalogue says 12.00 for both, so the server moves one up by 2.00 and the
    // other down by 2.00 - net +2.00, or 2.42 with tax.
    //
    // Counting only the upward line makes the allowance 4.84, and on an order that is *also*
    // under-tendered that extra 2.42 comes straight out of a debt the customer still owes. What the
    // customer's money actually fell short by is the net, and nothing else.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand(
            $uuid,
            [
                ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                    'qty' => '1', 'price_unit' => '8.00', 'discount' => '0'],
                ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                    'qty' => '1', 'price_unit' => '14.00', 'discount' => '0'],
            ],
            ['state' => OrderState::Paid->value, 'amount_total_client' => '26.62'],
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                // Well under even the till's own 26.62, so the shortfall is much larger than the
                // repricing explains and the bound is what decides the answer.
                'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '20.00',
            ]],
        ),
    ]])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    // 2 x 12.00 = 24.00 + 21% = 29.04.
    expect((string) $order->amount_total)->toBe('29.0400')
        ->and((string) $order->amount_write_off)->toBe('2.4200')
        // 29.04 - 20.00 tendered - 2.42 forgiven.
        ->and((string) $order->amount_due)->toBe('6.6200');
});

it('measures the repricing after the line discount, not before it', function (): void {
    // A 2.00 move on a half-price line is worth 1.00, not 2.00 - the discount is applied to the
    // unit price before tax, so that is where the repricing lands too. Reading the raw per-unit
    // difference doubles the allowance, which again only shows up once the order is short by more
    // than the repricing explains.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand(
            $uuid,
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '50',
            ]],
            ['state' => OrderState::Paid->value, 'amount_total_client' => '6.05'],
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(),
                'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '3.00',
            ]],
        ),
    ]])->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    // 12.00 less 50% = 6.00, + 21% = 7.26.
    expect((string) $order->amount_total)->toBe('7.2600')
        // (12.00 - 10.00) x 1 x 0.5 = 1.00 untaxed, 1.21 with tax.
        ->and((string) $order->amount_write_off)->toBe('1.2100')
        // 7.26 - 3.00 tendered - 1.21 forgiven.
        ->and((string) $order->amount_due)->toBe('3.0500');
});

it('leaves a part-paid order at the right price entirely alone', function (): void {
    // No stale catalogue at all: the till and the server agree on 12.10 and only 5.00 came in.
    // Nothing here is our pricing, so nothing is forgiven and the debt stands in full — and no
    // warning or audit row is raised either, because a zero write-off is not an event.
    $uuid = (string) Str::uuid();
    $response = settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '5.00')->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_write_off)->toBe('0.0000')
        ->and((string) $order->amount_due)->toBe('7.1000')
        ->and(array_column((array) $response->json('results.0.warnings'), 'code'))
        ->not->toContain('stale_price_written_off')
        ->and(AuditLog::query()->where('event', AuditEvent::StalePriceWrittenOff)->exists())->toBeFalse();
});

it('never turns a shortfall into a negative write-off', function (): void {
    // The case the two bounds only catch together. The catalogue moved *down* to 8.00 while the
    // till was still charging 10.00, and the order is also genuinely part-paid: 9.68 owed, 5.00
    // tendered. The due is positive, so the "nothing outstanding" bound does not fire — and the
    // price gap is −2.42, so a cap that took the gap unconditionally would write off a *negative*
    // amount, growing the debt to 7.10 and putting a negative figure into the session total and
    // from there into the export identity. The customer overpaying our own price is not a
    // shortfall, and there is nothing here to forgive.
    repriceCatalogue($this->fx, '8.00');

    $uuid = (string) Str::uuid();
    settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '5.00')->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_total)->toBe('9.6800')
        ->and((string) $order->amount_write_off)->toBe('0.0000')
        ->and((string) $order->amount_due)->toBe('4.6800');
});

it('writes nothing off while the order is still a draft', function (): void {
    // Nobody's money is on the counter yet. The next push simply charges the right amount, and
    // forgiving a shortfall here would discount a sale that has not happened.
    repriceCatalogue($this->fx, '12.00');

    $uuid = (string) Str::uuid();

    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand(
            $uuid,
            [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
            ]],
            ['amount_total_client' => '12.10'],
        ),
    ]])->assertOk();

    expect((string) Order::query()->where('uuid', $uuid)->value('amount_write_off'))->toBe('0.0000');
});

it('forgives nothing when the server priced the order lower', function (): void {
    // The mirror case: the catalogue dropped to 8.00 and the till charged 10.00. There is no
    // shortfall to forgive — the order is *over*paid — and a write-off here would be the server
    // handing money away on an order that already has too much of it.
    repriceCatalogue($this->fx, '8.00');

    $uuid = (string) Str::uuid();
    settleAtStalePrice($this->fx, $uuid, '10.00', '12.10', '12.10')->assertOk();

    $order = Order::query()->where('uuid', $uuid)->firstOrFail();

    expect((string) $order->amount_write_off)->toBe('0.0000')
        ->and((string) $order->amount_total)->toBe('9.6800');
});

it('puts the write-off on the audit trail with the device that took it', function (): void {
    // Not a fraud signal on its own — a stale catalogue does this — but it is money the venue
    // expected and did not get, so it needs a row naming when, which till, and how much.
    repriceCatalogue($this->fx, '12.00');

    settleAtStalePrice($this->fx, (string) Str::uuid(), '10.00', '12.10', '12.10')->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::StalePriceWrittenOff)->firstOrFail();

    expect((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey())
        ->and((int) $log->pos_session_id)->toBe((int) $this->fx->session->getKey())
        ->and($log->changes['amount_write_off']['new'])->toBe('2.4200');
});

// ── the session and the ledger ───────────────────────────────────────────────

it('freezes the write-off onto the session at close', function (): void {
    repriceCatalogue($this->fx, '12.00');

    settleAtStalePrice($this->fx, (string) Str::uuid(), '10.00', '12.10', '12.10')->assertOk();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '12.10'])
        ->assertOk();

    expect((string) PosSession::query()->whereKey($this->fx->session->getKey())->value('write_off_total'))
        ->toBe('2.4200');
});

it('balances the accounting export that the shortfall used to break', function (): void {
    // The whole point, and the assertion that would have caught this on the day BAN-502 shipped.
    // Before: sales 12.00 + tax 2.52 − payments 12.10 = an imbalance of 2.42 and no column
    // anywhere explaining it. The identity now carries the write-off on the sales side.
    repriceCatalogue($this->fx, '12.00');

    settleAtStalePrice($this->fx, (string) Str::uuid(), '10.00', '12.10', '12.10')->assertOk();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '12.10'])
        ->assertOk();

    $session = PosSession::query()->whereKey($this->fx->session->getKey())->firstOrFail();

    $export = app(AccountingExportService::class)->build(
        companyId: (int) $this->fx->company->getKey(),
        periodStart: (string) $session->business_date,
        periodEnd: (string) $session->business_date,
    );

    expect((string) $export->total_sales)->toBe('12.0000')
        ->and((string) $export->total_tax)->toBe('2.5200')
        ->and((string) $export->total_payments)->toBe('12.1000')
        ->and((string) $export->total_write_off)->toBe('2.4200')
        ->and((string) $export->imbalance_amount)->toBe('0.0000');
});

it('names the write-off in the export file rather than netting it away', function (): void {
    // Balanced is not the same as explained. An accountant reconciling by hand sees sales that
    // exceed payments and needs the file itself to say why, on its own row.
    repriceCatalogue($this->fx, '12.00');

    settleAtStalePrice($this->fx, (string) Str::uuid(), '10.00', '12.10', '12.10')->assertOk();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '12.10'])
        ->assertOk();

    $session = PosSession::query()->whereKey($this->fx->session->getKey())->firstOrFail();

    $export = app(AccountingExportService::class)->build(
        companyId: (int) $this->fx->company->getKey(),
        periodStart: (string) $session->business_date,
        periodEnd: (string) $session->business_date,
    );

    $lines = array_values(array_filter(explode("\n", (string) Storage::disk($export->file->disk)->get($export->file->path))));
    $header = str_getcsv((string) array_shift($lines));

    $rows = [];
    foreach ($lines as $line) {
        $row = array_combine($header, str_getcsv($line));
        $rows[$row['kind']] = $row;
    }

    // Compared as a number, not a string: these columns come straight off the query builder, so
    // their textual scale is the driver's business (`2.42` on SQLite, `2.4200` on MySQL) and the
    // rest of the export's rows are read the same way.
    expect($rows)->toHaveKey('write_off')
        ->and((float) $rows['write_off']['total'])->toBe(2.42)
        ->and($rows['write_off']['label'])->toBe((string) $session->name);
});

it('leaves the export alone when nothing was written off', function (): void {
    // The ordinary session: no stale price, no write-off row, no new column doing anything. A
    // change to the identity that moved the ordinary case would be worse than the bug.
    test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $this->fx->orderCommand((string) Str::uuid(), [], ['state' => OrderState::Paid->value], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '24.20',
        ]]),
    ]])->assertOk();

    test()->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$this->fx->session->getKey()}/close", ['counted_cash' => '24.20'])
        ->assertOk();

    $session = PosSession::query()->whereKey($this->fx->session->getKey())->firstOrFail();

    $export = app(AccountingExportService::class)->build(
        companyId: (int) $this->fx->company->getKey(),
        periodStart: (string) $session->business_date,
        periodEnd: (string) $session->business_date,
    );

    expect((string) $export->total_write_off)->toBe('0.0000')
        ->and((string) $export->imbalance_amount)->toBe('0.0000');
});
