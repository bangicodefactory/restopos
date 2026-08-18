<?php

declare(strict_types=1);

namespace Tests\Feature\Reporting\TipReporting;

use App\Models\Pos\Order;
use App\Services\Pos\SessionSummaryService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();
});

/**
 * A settled sale in this session, tipped, attributed to a cashier.
 *
 * Pushed through `/api/pos/sync` rather than inserted, so every column the migration insists on is
 * filled by the code that normally fills it — a hand-written insert here would be a second, weaker
 * definition of what a settled order is.
 */
function settled(PosFixtures $fx, string $tip, ?int $employeeId = null, bool $refund = false): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '20.00', 'discount' => '0',
        ]], ['state' => 'paid'], [[
            'op' => 'create', 'uuid' => (string) Str::uuid(),
            'payment_method_id' => $fx->card->getKey(),
            'amount' => '24.20', 'is_change' => false, 'is_refund' => false, 'payment_status' => 'done',
        ]])],
    ])->assertOk();

    // The tip and the cashier are set directly: this suite is about how the report *reads* them, and
    // the write path they come from is BAN-494's, already covered by `TipAfterPaymentTest`.
    Order::query()->where('uuid', $uuid)->update([
        'employee_id' => $employeeId,
        'is_refund' => $refund,
        'is_tipped' => true,
        'tip_amount' => $tip,
    ]);

    return $uuid;
}

function tipRows(PosFixtures $fx): array
{
    return app(SessionSummaryService::class)->tipsByCashierRows([(int) $fx->session->getKey()]);
}

/**
 * RST-129 (BAN-522) — tips per cashier on the session report.
 *
 * Tips are the one figure on the report that is not the venue's money: counted in the takings
 * because the card was charged for them, and owed straight back out again. A report that shows only
 * a session total leaves whoever shares them out counting receipts by hand.
 */
it('totals a cashier tips across their sales', function (): void {
    $amina = (int) $this->fx->cashier->getKey();

    settled($this->fx, '3.0000', $amina);
    settled($this->fx, '4.5000', $amina);

    $rows = tipRows($this->fx);

    expect($rows)->toHaveCount(1)
        ->and((float) $rows[0]['tip_amount'])->toBe(7.5)
        ->and($rows[0]['employee_id'])->toBe($amina)
        ->and($rows[0]['order_count'])->toBe(2);
});

it('keeps cashiers apart, which is the whole point of the panel', function (): void {
    $amina = (int) $this->fx->cashier->getKey();

    $sami = (int) DB::table('employees')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Sami',
        'active' => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    settled($this->fx, '3.0000', $amina);
    settled($this->fx, '9.0000', $sami);

    $byEmployee = collect(tipRows($this->fx))->keyBy('employee_id');

    expect((float) $byEmployee[$amina]['tip_amount'])->toBe(3.0)
        ->and((float) $byEmployee[$sami]['tip_amount'])->toBe(9.0)
        ->and($byEmployee[$sami]['employee_name'])->toBe('Sami');
});

it('leaves out a cashier who took no tips', function (): void {
    // A list of what is owed out; a row of zero is noise on a slip read at the end of a shift.
    settled($this->fx, '0.0000', (int) $this->fx->cashier->getKey());

    expect(tipRows($this->fx))->toBeEmpty();
});

it('excludes refunds rather than netting them off', function (): void {
    // A refunded sale returns its tip with it. Netted, a busy cashier's row can go negative, which
    // reads as money owed *by* them — the opposite of what this panel is for.
    $amina = (int) $this->fx->cashier->getKey();

    settled($this->fx, '5.0000', $amina);
    settled($this->fx, '5.0000', $amina, refund: true);

    expect((float) tipRows($this->fx)[0]['tip_amount'])->toBe(5.0)
        ->and(tipRows($this->fx)[0]['order_count'])->toBe(1);
});

it('still reports a tip taken with no cashier attached', function (): void {
    // `employee_id` is nullable — a register with employee login switched off books every sale
    // without one. Dropping those rows would hide real money.
    settled($this->fx, '6.0000', null);

    $rows = tipRows($this->fx);

    expect($rows)->toHaveCount(1)
        ->and($rows[0]['employee_id'])->toBeNull()
        ->and((float) $rows[0]['tip_amount'])->toBe(6.0);
});

it('ignores a draft, which has taken no money yet', function (): void {
    $uuid = settled($this->fx, '4.0000', (int) $this->fx->cashier->getKey());
    Order::query()->where('uuid', $uuid)->update(['state' => 'draft']);

    expect(tipRows($this->fx))->toBeEmpty();
});

it('reports nothing for no sessions rather than scanning the table', function (): void {
    expect(app(SessionSummaryService::class)->tipsByCashierRows([]))->toBe([]);
});
