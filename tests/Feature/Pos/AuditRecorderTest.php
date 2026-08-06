<?php

declare(strict_types=1);

use App\Enums\OrderEditAction;
use App\Models\Audit\OrderEditLog;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Services\Audit\AuditRecorder;
use App\Services\Audit\OrderEditRecorder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-413 — the recorders on their own, not through the ingest path.
 *
 * This file exists because of something the sabotage check turned up. `OrderSyncService::updateLine`
 * and `OrderEditRecorder::lineChanged` each decide independently whether anything actually changed,
 * and the ingest-level tests pass as long as *either* one holds. Breaking one alone left the whole
 * suite green — so the recorder's own guard, the one every future caller will rely on, had never
 * once executed under test. A guard that has never fired is indistinguishable from one that works.
 *
 * So these call the recorder directly, where nothing upstream can cover for it.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make(['order_edit_tracking' => true])->withSession();

    $this->order = Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_session_id' => $this->fx->session->getKey(),
        'name' => 'T/0001',
        'access_token' => (string) Str::uuid(),
        'currency_id' => $this->fx->config->currency_id,
        'state' => 'draft',
        'ordered_at' => now(),
        'amount_total' => '20.0000',
    ]);

    $this->line = OrderLine::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_order_id' => $this->order->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'line_number' => 1,
        'product_variant_id' => $this->fx->variant->getKey(),
        'product_id' => $this->fx->product->getKey(),
        'uom_id' => $this->fx->product->uom_id,
        'full_product_name' => 'Margherita',
        'quantity' => '2',
        'price_unit' => '10.00',
        'price_extra' => '0',
        'discount_percent' => '0',
        'tax_signature' => '',
    ]);

    $this->recorder = app(OrderEditRecorder::class);
});

describe('OrderEditRecorder::lineChanged', function (): void {
    it('writes nothing when the update repeats what the line already holds', function (): void {
        // The guard the ingest tests could never reach past their own.
        $before = ['quantity' => '2.000', 'price_unit' => '10.0000', 'discount_percent' => '0.0000'];

        $this->recorder->lineChanged(
            $this->fx->config,
            $this->order,
            $this->line,
            $before,
            ['quantity' => '2', 'price_unit' => '10.00', 'discount_percent' => '0'],
        );

        expect(OrderEditLog::query()->count())->toBe(0);
    });

    it('writes one row for the one field that moved', function (): void {
        $this->recorder->lineChanged(
            $this->fx->config,
            $this->order,
            $this->line,
            ['quantity' => '2.000', 'price_unit' => '10.0000'],
            ['quantity' => '2.000', 'price_unit' => '12.00'],
        );

        $logs = OrderEditLog::query()->get();

        expect($logs)->toHaveCount(1)
            ->and($logs->first()->action)->toBe(OrderEditAction::PriceChanged)
            // €2 more, twice over.
            ->and((string) $logs->first()->amount_impact)->toBe('4.0000');
    });

    it('ignores a field it does not track', function (): void {
        // `skip_preparation` moving is not an edit to the ticket, and a row for it would be noise in
        // the one place noise is most expensive.
        $this->recorder->lineChanged(
            $this->fx->config,
            $this->order,
            $this->line,
            ['skip_preparation' => false],
            ['skip_preparation' => true],
        );

        expect(OrderEditLog::query()->count())->toBe(0);
    });

    it('respects the gate on its own, not only through the caller', function (): void {
        $off = PosFixtures::make(['order_edit_tracking' => false]);

        $this->recorder->lineChanged(
            $off->config,
            $this->order,
            $this->line,
            ['quantity' => '2.000'],
            ['quantity' => '1'],
        );

        expect(OrderEditLog::query()->count())->toBe(0);
    });
});

describe('AuditRecorder::diff', function (): void {
    it('treats a value and its padded form as the same number', function (): void {
        // The single comparison the whole "do not log a resend" property rests on. Everything the
        // register pushes is a string, and the column pads it — `'2'` and `'2.000'` are one quantity.
        expect(AuditRecorder::diff(['qty' => '2.000'], ['qty' => '2']))->toBe([])
            ->and(AuditRecorder::diff(['price' => '10.0000'], ['price' => '10']))->toBe([])
            ->and(AuditRecorder::diff(['d' => '0.0000'], ['d' => '0']))->toBe([]);
    });

    it('does not collapse values that only look alike', function (): void {
        expect(AuditRecorder::diff(['qty' => '2.000'], ['qty' => '2.001']))
            ->toBe(['qty' => ['old' => '2.000', 'new' => '2.001']]);
    });

    it('compares booleans as booleans, not as strings', function (): void {
        // `false` stringifies to '' and `0` to '0'; comparing those as text reports a change on
        // every push of a flag that never moved.
        expect(AuditRecorder::diff(['flag' => 0], ['flag' => false]))->toBe([])
            ->and(AuditRecorder::diff(['flag' => 1], ['flag' => true]))->toBe([])
            ->and(AuditRecorder::diff(['flag' => false], ['flag' => true]))
            ->toBe(['flag' => ['old' => false, 'new' => true]]);
    });

    it('reports a field the old state never had', function (): void {
        expect(AuditRecorder::diff([], ['note' => 'no onions']))
            ->toBe(['note' => ['old' => null, 'new' => 'no onions']]);
    });

    it('treats null and the empty string as the same absence', function (): void {
        // A cleared note arrives as `''` from one path and `null` from another. Logging that as an
        // edit means every order with an untouched note field logs one.
        expect(AuditRecorder::diff(['note' => null], ['note' => '']))->toBe([]);
    });

    it('ignores keys the update does not mention', function (): void {
        // An update carries only the fields the client sent; the rest are not "removed".
        expect(AuditRecorder::diff(['qty' => '2', 'price' => '10'], ['qty' => '2']))->toBe([]);
    });
});
