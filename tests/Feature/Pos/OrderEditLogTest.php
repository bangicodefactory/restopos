<?php

declare(strict_types=1);

use App\Enums\CashMovementType;
use App\Enums\OrderEditAction;
use App\Enums\OrderState;
use App\Models\Audit\AuditLog;
use App\Models\Audit\OrderEditLog;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Services\Pos\SessionService;
use App\Support\Audit\AuditEvent;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-413 — the audit trail, which until now nothing wrote.
 *
 * Two purpose-built tables shipped with models, enums, indexes and a spec entry, and the only INSERT
 * into either of them anywhere in the repository was in a demo seeder. So "who removed that line",
 * "who opened the drawer at 23:40" and "who turned cash control off" had no answer — which is the
 * half of fraud detection that has to survive the shift it happened in.
 *
 * The failure this file is really guarding against is subtler than "nothing is written". It is
 * **writing too much**: a register re-pushes a draft on every edit and again at payment, so a
 * recorder that logs on receipt rather than on change produces hundreds of rows saying nothing, on
 * exactly the busiest till, and buries the two rows that matter. Half the cases below exist to hold
 * that line.
 */
beforeEach(function (): void {
    // Edit tracking on: it is off by default, and every order-edit assertion here depends on it.
    $this->fx = PosFixtures::make(['order_edit_tracking' => true])->withSession();
});

/** Push a sync payload as a till would, employee attributed. */
function push(PosFixtures $fx, array $payload): TestResponse
{
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $fx->cashier->getKey(),
        ...$payload,
    ]);
}

/** One line, spelled out, so a test can vary exactly one field of it. */
function line(PosFixtures $fx, string $uuid, array $overrides = []): array
{
    return [
        'op' => 'create',
        'uuid' => $uuid,
        'variant_id' => $fx->variant->getKey(),
        'qty' => '2',
        'price_unit' => '10.00',
        'discount' => '0',
        ...$overrides,
    ];
}

/**
 * An `audit.batch` carrying one drawer opening, shaped as the till sends it.
 *
 * The event's uuid is minted once per call, not per delivery — the redelivery test depends on
 * reusing the same command, which is exactly what the outbox does.
 */
function drawerBatch(PosFixtures $fx, string $reason): array
{
    return [
        'uuid' => (string) Str::uuid(),
        'kind' => 'audit.batch',
        'payload' => ['events' => [[
            'uuid' => (string) Str::uuid(),
            'event' => 'cash.drawer.opened',
            'at' => now()->toIso8601ZuluString(),
            'session_id' => $fx->session?->getKey(),
            'detail' => ['reason' => $reason],
        ]]],
    ];
}

function editLogs(?OrderEditAction $action = null): Collection
{
    $query = OrderEditLog::query()->orderBy('id');

    if ($action !== null) {
        $query->where('action', $action->value);
    }

    return $query->get();
}

// ---------------------------------------------------------------- the acceptance criterion

it('records a scripted shift: two voids and a discount produce exactly three rows', function (): void {
    // The ticket's acceptance criterion, literally. Three edits, three rows — no more, which is the
    // part that is easy to get wrong, and no fewer.
    $orderUuid = (string) Str::uuid();
    $lineA = (string) Str::uuid();
    $lineB = (string) Str::uuid();
    $lineC = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        line($this->fx, $lineA),
        line($this->fx, $lineB),
        line($this->fx, $lineC),
    ])]])->assertOk();

    // Three lines added; the additions are logged too, so clear them to count the edits alone.
    expect(editLogs(OrderEditAction::LineAdded))->toHaveCount(3);
    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'delete', 'uuid' => $lineA],
        ['op' => 'delete', 'uuid' => $lineB],
        ['op' => 'update', 'uuid' => $lineC, 'discount' => '50'],
    ])]])->assertOk();

    $logs = editLogs();

    expect($logs)->toHaveCount(3)
        ->and($logs->pluck('action')->map(static fn ($a): string => $a->value)->all())
        ->toBe(['line_removed', 'line_removed', 'discount_changed']);

    $discount = $logs->last();

    expect($discount->old_value)->toBe('0')
        ->and($discount->new_value)->toBe('50')
        // Half of a €20 line.
        ->and((string) $discount->amount_impact)->toBe('-10.0000');
});

it('carries the employee, the device and the order on every row', function (): void {
    $orderUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid)]])->assertOk();

    $order = Order::query()->where('uuid', $orderUuid)->firstOrFail();
    $logs = editLogs();

    expect($logs)->not->toBeEmpty();

    foreach ($logs as $log) {
        expect((int) $log->employee_id)->toBe((int) $this->fx->cashier->getKey())
            // The column this ticket added: two tills, one shared PIN, and the employee alone no
            // longer says who was standing there.
            ->and((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey())
            ->and((int) $log->pos_order_id)->toBe((int) $order->getKey());
    }
});

// ---------------------------------------------------------------- writing too much

it('writes nothing at all when a till resends a line it has not changed', function (): void {
    // The case that decides whether this table is usable. A draft is pushed on every edit and again
    // at payment, so the same line arrives many times over with the same values. Logging on receipt
    // rather than on change turns a shift's two real edits into two hundred rows, and does it worst
    // on the till you would actually be investigating.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();

    OrderEditLog::query()->delete();

    // Three resends of exactly the same line, as the outbox would.
    foreach (range(1, 3) as $ignored) {
        push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
            ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '2', 'price_unit' => '10.00', 'discount' => '0'],
        ])]])->assertOk();
    }

    expect(editLogs())->toHaveCount(0);
});

it('does not mistake the column format for an edit', function (): void {
    // `quantity` casts to decimal:3, so a line stored as `'2'` reads back `'2.000'`. Comparing those
    // as strings logs a quantity change on every single resend — the bug that would make the case
    // above pass for one push and fail for the next.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid, ['qty' => '2'])])]])->assertOk();
    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '2.000', 'price_unit' => '10.0000'],
    ])]])->assertOk();

    expect(editLogs())->toHaveCount(0);
});

it('leaves is_edited alone on a resend', function (): void {
    // The same defect, seen from the flag rather than the table. `is_edited` was set on every update
    // command, so every line on every order was flagged within seconds of being rung up — and the
    // back-office "which orders were edited" view (BOF-139) that filters on it matched everything.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '2', 'price_unit' => '10.00'],
    ])]])->assertOk();

    expect((bool) OrderLine::query()->where('uuid', $lineUuid)->value('is_edited'))->toBeFalse()
        ->and((bool) Order::query()->where('uuid', $orderUuid)->value('is_edited'))->toBeFalse();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '1'],
    ])]])->assertOk();

    expect((bool) OrderLine::query()->where('uuid', $lineUuid)->value('is_edited'))->toBeTrue()
        ->and((bool) Order::query()->where('uuid', $orderUuid)->value('is_edited'))->toBeTrue();
});

// ---------------------------------------------------------------- what each edit says

it('tells a quantity cut from a quantity rise', function (): void {
    // Only one of these two is the fraud shape, and a report that cannot separate them is a list of
    // every keystroke on the till.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid, ['qty' => '3'])])]])->assertOk();
    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '1'],
    ])]])->assertOk();

    $cut = editLogs()->first();

    expect($cut->action)->toBe(OrderEditAction::QtyDecreased)
        ->and($cut->old_value)->toBe('3')
        ->and($cut->new_value)->toBe('1')
        // Two units off a €10 line.
        ->and((string) $cut->amount_impact)->toBe('-20.0000');

    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '4'],
    ])]])->assertOk();

    $rise = editLogs()->first();

    expect($rise->action)->toBe(OrderEditAction::QtyIncreased)
        ->and((string) $rise->amount_impact)->toBe('30.0000');
});

it('emits one row per changed field, not one per command', function (): void {
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();
    OrderEditLog::query()->delete();

    // One command, three things moved.
    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '1', 'price_unit' => '8.00', 'discount' => '10'],
    ])]])->assertOk();

    expect(editLogs()->pluck('action')->map(static fn ($a): string => $a->value)->all())
        ->toBe(['qty_decreased', 'price_changed', 'discount_changed']);
});

it('keeps the record of a line after the line is gone', function (): void {
    // `pos_order_line_id` is nulled by the FK when the line goes. Without the uuid beside it, the
    // delete would erase the only evidence the line was ever rung up — the single most useful fact
    // the table holds.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'delete', 'uuid' => $lineUuid],
    ])]])->assertOk();

    expect(OrderLine::query()->where('uuid', $lineUuid)->exists())->toBeFalse();

    $removed = editLogs(OrderEditAction::LineRemoved)->first();

    expect($removed)->not->toBeNull()
        ->and($removed->pos_order_line_uuid)->toBe($lineUuid)
        ->and($removed->product_name)->toBe('Margherita')
        ->and($removed->old_value)->toBe('2')
        ->and((string) $removed->amount_impact)->toBe('-20.0000');
});

it('flags the order as having lost a line', function (): void {
    // `has_deleted_line` is what a back-office list filters on to find the orders worth opening, and
    // nothing set it.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();

    expect((bool) Order::query()->where('uuid', $orderUuid)->value('has_deleted_line'))->toBeFalse();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'delete', 'uuid' => $lineUuid],
    ])]])->assertOk();

    expect((bool) Order::query()->where('uuid', $orderUuid)->value('has_deleted_line'))->toBeTrue();
});

it('records a payment whose amount was restated after the fact', function (): void {
    // The classic skim: ring up €40 cash, print, then quietly restate it as €30 and pocket the
    // difference. The order still balances and the session still reconciles against what was
    // declared — nothing else in the system notices.
    $orderUuid = (string) Str::uuid();
    $paymentUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => $paymentUuid, 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '40.00'],
    ])]])->assertOk();

    OrderEditLog::query()->delete();
    AuditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [], ['state' => OrderState::Paid->value], [
        ['op' => 'update', 'uuid' => $paymentUuid, 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '30.00'],
    ])]])->assertOk();

    $changed = editLogs(OrderEditAction::PaymentChanged)->first();

    expect($changed)->not->toBeNull()
        ->and($changed->old_value)->toBe('40')
        ->and($changed->new_value)->toBe('30')
        ->and((string) $changed->amount_impact)->toBe('-10.0000');

    // And on the company-wide trail, because this one is not an edit — it is a restatement of what
    // was taken, and it survives `order_edit_tracking` being turned off.
    expect(AuditLog::query()->where('event', AuditEvent::OrderPaymentChanged)->count())->toBe(1);
});

it('does not call the first payment on an order a change', function (): void {
    // Tendering is not editing. A row here for every sale would be the same flood in a different
    // table.
    push($this->fx, ['orders' => [$this->fx->orderCommand((string) Str::uuid(), [], ['state' => OrderState::Paid->value], [
        ['op' => 'create', 'uuid' => (string) Str::uuid(), 'payment_method_id' => $this->fx->cash->getKey(), 'amount' => '20.00'],
    ])]])->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::OrderPaymentChanged)->count())->toBe(0);
});

// ---------------------------------------------------------------- the gate

it('suppresses the edit rows when the register has tracking off, and keeps the audit rows', function (): void {
    // The ticket's fourth acceptance criterion, and the reason the two tables are separate. A venue
    // that does not want a row per keystroke still gets drawer opens, cash moves and session closes.
    $fx = PosFixtures::make(['order_edit_tracking' => false])->withSession();

    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($fx, ['orders' => [$fx->orderCommand($orderUuid, [line($fx, $lineUuid)])]])->assertOk();
    push($fx, ['orders' => [$fx->orderCommand($orderUuid, [['op' => 'delete', 'uuid' => $lineUuid]])]])->assertOk();

    expect(editLogs())->toHaveCount(0);

    push($fx, ['commands' => [drawerBatch($fx, 'no_sale')]])->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->count())->toBe(1);
});

// ---------------------------------------------------------------- the drawer

it('records a drawer opening reported by the till', function (): void {
    // The drawer is opened by an ESC/POS pulse straight from the browser to the printer, so nothing
    // about it reached the server at all — the one money-adjacent action with no row of any kind.
    $response = push($this->fx, ['commands' => [drawerBatch($this->fx, 'cash_payment')]]);

    $response->assertOk()->assertJsonPath('results.0.written', 1);

    $log = AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->firstOrFail();

    expect((int) $log->pos_session_id)->toBe((int) $this->fx->session->getKey())
        ->and((int) $log->pos_device_id)->toBe((int) $this->fx->device->getKey())
        ->and((int) $log->actor_employee_id)->toBe((int) $this->fx->cashier->getKey())
        ->and($log->severity->value)->toBe('info');
});

it('raises the severity of a no-sale opening', function (): void {
    // A drawer opened with no order behind it is the one a manager goes looking for, and it has to
    // be findable without reading every row.
    push($this->fx, ['commands' => [drawerBatch($this->fx, 'no_sale')]])->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->value('severity')?->value)->toBe('warning');
});

it('does not invent a second opening when the outbox delivers the batch twice', function (): void {
    // The outbox redelivers as a matter of routine — that is what makes it able to survive an
    // outage. A trail that counts each redelivery reports drawer openings that never happened.
    $command = drawerBatch($this->fx, 'cash_payment');

    push($this->fx, ['commands' => [$command]])->assertOk()->assertJsonPath('results.0.written', 1);
    push($this->fx, ['commands' => [$command]])->assertOk()->assertJsonPath('results.0.skipped', 1);

    expect(AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->count())->toBe(1);
});

it('refuses to let a till write an event name of its own choosing', function (): void {
    // The trail is partly evidence about the till, and the device bearer token lives on the till. A
    // passthrough would let anyone holding a paired device forge a `session.closed` or a
    // `cash.move.deleted` into the one artefact that is supposed to be trustworthy — and forge it
    // with a real device id and a real employee attached, which is worse than no row at all.
    $forged = [
        'uuid' => (string) Str::uuid(),
        'kind' => 'audit.batch',
        'payload' => ['events' => [
            [
                'uuid' => (string) Str::uuid(),
                'event' => AuditEvent::SessionClosed,
                'at' => now()->toIso8601ZuluString(),
                'session_id' => $this->fx->session->getKey(),
            ],
            [
                'uuid' => (string) Str::uuid(),
                'event' => AuditEvent::CashMoveDeleted,
                'at' => now()->toIso8601ZuluString(),
            ],
        ]],
    ];

    push($this->fx, ['commands' => [$forged]])
        ->assertOk()
        ->assertJsonPath('results.0.written', 0)
        ->assertJsonPath('results.0.skipped', 2);

    expect(AuditLog::query()->count())->toBe(0);
});

it('keeps the events it understands out of a batch that also carries junk', function (): void {
    // One bad entry must not cost the real ones. Same rule as the order batch: a poisoned record is
    // rejected on its own, never on behalf of the ones beside it.
    $batch = drawerBatch($this->fx, 'no_sale');
    $batch['payload']['events'][] = [
        'uuid' => (string) Str::uuid(),
        'event' => 'session.closed',
        'at' => now()->toIso8601ZuluString(),
    ];

    push($this->fx, ['commands' => [$batch]])
        ->assertOk()
        ->assertJsonPath('results.0.written', 1)
        ->assertJsonPath('results.0.skipped', 1);

    expect(AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->count())->toBe(1);
});

// ---------------------------------------------------------------- session and cash

it('records a session opening and its close', function (): void {
    $fx = PosFixtures::make();

    /** @var SessionService $sessions */
    $sessions = app(SessionService::class);

    $session = $sessions->open($fx->config, '100.00', $fx->cashier->getKey());

    expect(AuditLog::query()->where('event', AuditEvent::SessionOpened)->count())->toBe(1);

    $sessions->close($session, '100.00', employeeId: $fx->cashier->getKey());

    $closed = AuditLog::query()->where('event', AuditEvent::SessionClosed)->firstOrFail();

    // A close that balances is routine; the severity is what makes one that does not findable.
    expect($closed->severity->value)->toBe('info')
        ->and((int) $closed->pos_session_id)->toBe((int) $session->getKey());
});

it('marks a close that does not balance', function (): void {
    $fx = PosFixtures::make();

    /** @var SessionService $sessions */
    $sessions = app(SessionService::class);

    $session = $sessions->open($fx->config, '100.00', $fx->cashier->getKey());
    $sessions->close($session, '80.00', employeeId: $fx->cashier->getKey());

    $closed = AuditLog::query()->where('event', AuditEvent::SessionClosed)->firstOrFail();

    expect($closed->severity->value)->toBe('warning')
        ->and($closed->changes['cash_difference']['new'])->toBe('-20.0000');
});

it('records a cash movement, and separately the deletion of one', function (): void {
    /** @var SessionService $sessions */
    $sessions = app(SessionService::class);

    $movement = $sessions->cashMove(
        session: $this->fx->session,
        type: CashMovementType::CashOut,
        amount: '50.00',
        reason: 'Supplier',
        employeeId: $this->fx->cashier->getKey(),
    );

    expect(AuditLog::query()->where('event', AuditEvent::CashMoveCreated)->count())->toBe(1);

    $sessions->deleteCashMovement($movement);

    $deleted = AuditLog::query()->where('event', AuditEvent::CashMoveDeleted)->firstOrFail();

    // "€50 left the drawer and then the record of it was removed" is a different fact from either
    // half on its own, so the deletion carries the amount that is about to stop existing.
    expect($deleted->severity->value)->toBe('warning')
        ->and($deleted->changes['amount']['old'])->toBe('-50.0000');
});

it('logs the movement and not the request when a batch is replayed', function (): void {
    // Cash moves are idempotent on their uuid — a flaky connection resends them. Logging the request
    // rather than the movement turns one cash-out into three.
    $command = [
        'uuid' => (string) Str::uuid(),
        'kind' => 'session.cash_move',
        'payload' => [
            'session_id' => $this->fx->session->getKey(),
            'movement_type' => CashMovementType::CashOut->value,
            'amount' => '25.00',
            'uuid' => (string) Str::uuid(),
        ],
    ];

    push($this->fx, ['commands' => [$command]])->assertOk();
    push($this->fx, ['commands' => [$command]])->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::CashMoveCreated)->count())->toBe(1);
});

it('records a cancelled order on both trails', function (): void {
    $orderUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid)]])->assertOk();
    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [[
        ...$this->fx->orderCommand($orderUuid, []),
        'op' => 'cancel',
        'lines' => [],
    ]]])->assertOk();

    expect(editLogs(OrderEditAction::OrderCancelled))->toHaveCount(1)
        ->and(AuditLog::query()->where('event', AuditEvent::OrderCancelled)->count())->toBe(1);
});

it('never sends the trail to a client', function (): void {
    // Spec §5.4. The trail describes the people using the till, to the people who employ them; a
    // register that could read it back is a register a curious cashier can read it from.
    $bootstrap = test()->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap');

    $bootstrap->assertOk();

    $body = $bootstrap->json();

    expect(json_encode($body))->not->toContain('audit_log')
        ->and(json_encode($body))->not->toContain('order_edit_log');
});

// ---------------------------------------------------------------- manager overrides

it('puts a manager override on the trail', function (): void {
    // The client half shipped long ago — `approval.ts` verifies the PIN, writes an `ApprovalRow`
    // and says in its own docblock that the approval "is recorded and synced". It was recorded.
    // `persistence.ts` sent `approvals: []`, hardcoded, so the record of who authorised a discount
    // lived on the granting till and nowhere else: clear that device, and it is gone.
    $orderUuid = (string) Str::uuid();
    $approvalUuid = (string) Str::uuid();

    $command = $this->fx->orderCommand($orderUuid);
    $command['approvals'] = [[
        'uuid' => $approvalUuid,
        'ability' => 'order.discount',
        'manager_employee_id' => $this->fx->manager->getKey(),
        'verified' => 'online',
        'at' => now()->toIso8601ZuluString(),
        'context' => [],
    ]];

    push($this->fx, ['orders' => [$command]])->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->firstOrFail();

    expect($log->uuid)->toBe($approvalUuid)
        ->and((int) $log->actor_employee_id)->toBe((int) $this->fx->manager->getKey())
        ->and($log->changes['ability']['new'])->toBe('order.discount')
        ->and($log->severity->value)->toBe('notice');
});

it('marks an override that could only be checked offline', function (): void {
    // An offline grant was verified against a cached PIN hash and nothing else. A report that
    // cannot tell the two apart is one a determined cashier can hide in.
    $command = $this->fx->orderCommand((string) Str::uuid());
    $command['approvals'] = [[
        'uuid' => (string) Str::uuid(),
        'ability' => 'order.line.delete',
        'manager_employee_id' => $this->fx->manager->getKey(),
        'verified' => 'offline',
        'at' => now()->toIso8601ZuluString(),
    ]];

    push($this->fx, ['orders' => [$command]])->assertOk();

    expect(AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->value('severity')?->value)
        ->toBe('warning');
});

it('counts one override once, however many times its order is pushed', function (): void {
    // An order is pushed on every edit and again at payment, carrying its approvals each time.
    // Counting per push turns one authorised discount into a manager who overrode it forty times.
    $orderUuid = (string) Str::uuid();
    $command = $this->fx->orderCommand($orderUuid);
    $command['approvals'] = [[
        'uuid' => (string) Str::uuid(),
        'ability' => 'order.discount',
        'manager_employee_id' => $this->fx->manager->getKey(),
        'verified' => 'online',
        'at' => now()->toIso8601ZuluString(),
    ]];

    foreach (range(1, 3) as $ignored) {
        // `assertOk` is not enough here and this test proved it. `audit_logs.uuid` is unique, so
        // without the dedupe the second insert throws — the count stays 1, the response is still
        // 200, and the test passes while *the whole order push has been failing since push two*.
        // The per-record status is the assertion that tells those two worlds apart.
        push($this->fx, ['orders' => [$command]])
            ->assertOk()
            ->assertJsonPath('results.0.status', 'ok');
    }

    expect(AuditLog::query()->where('event', AuditEvent::EmployeeOverride)->count())->toBe(1);
});

it('bounds the detail a till can attach to an event', function (): void {
    // `detail` is client-supplied and lands in a `json` column with no length of its own. Copying
    // it verbatim makes a paired device a licence to fill the disk.
    $batch = drawerBatch($this->fx, 'no_sale');
    $batch['payload']['events'][0]['detail'] = [
        'reason' => 'no_sale',
        ...array_combine(
            array_map(static fn (int $i): string => "pad{$i}", range(1, 40)),
            array_fill(0, 40, str_repeat('x', 5000)),
        ),
    ];

    push($this->fx, ['commands' => [$batch]])->assertOk();

    $log = AuditLog::query()->where('event', AuditEvent::CashDrawerOpened)->firstOrFail();

    expect(count($log->changes->toArray()))->toBeLessThanOrEqual(9)
        ->and(strlen((string) json_encode($log->changes)))->toBeLessThan(2000)
        // …and the field that matters still made it through.
        ->and($log->changes['reason']['new'])->toBe('no_sale');
});

// ---------------------------------------------------------------- signs, and the refund case

it('points the impact the right way when a refund line is removed', function (): void {
    // A refund line carries a negative extended amount, so taking one off the ticket puts money
    // *back*. The first cut of this hardcoded a minus sign, which reported removing a −€20 refund
    // as another €20 taken off — in the one column a fraud report ranks by, on the one kind of
    // order fraud actually lives in.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        line($this->fx, $lineUuid, ['qty' => '-2']),
    ], ['is_refund' => true])]])->assertOk();

    // Adding the refund line takes €20 off the ticket…
    expect((string) editLogs(OrderEditAction::LineAdded)->first()->amount_impact)->toBe('-20.0000');

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'delete', 'uuid' => $lineUuid],
    ])]])->assertOk();

    // …and removing it puts the €20 back.
    expect((string) editLogs(OrderEditAction::LineRemoved)->first()->amount_impact)->toBe('20.0000');
});

it('points the impact the right way when a refund order is cancelled', function (): void {
    $orderUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        line($this->fx, (string) Str::uuid(), ['qty' => '-2']),
    ], ['is_refund' => true])]])->assertOk();

    OrderEditLog::query()->delete();

    $cancel = $this->fx->orderCommand($orderUuid, []);
    $cancel['op'] = 'cancel';
    $cancel['lines'] = [];

    push($this->fx, ['orders' => [$cancel]])->assertOk();

    $total = (string) Order::query()->where('uuid', $orderUuid)->value('amount_total');
    $impact = (string) editLogs(OrderEditAction::OrderCancelled)->first()->amount_impact;

    expect(bccomp($total, '0', 4))->toBeLessThan(0)
        ->and(bccomp($impact, '0', 4))->toBeGreaterThan(0);
});

it('logs a change to the option surcharge', function (): void {
    // `price_extra` was compared but not tracked: raising it flipped `is_edited` and wrote no row,
    // so a manager opening the flagged order found nothing that explained the flag.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        line($this->fx, $lineUuid, ['qty' => '1', 'price_extra' => '0']),
    ])]])->assertOk();

    OrderEditLog::query()->delete();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'price_extra' => '5.00'],
    ])]])->assertOk();

    $row = editLogs(OrderEditAction::PriceChanged)->first();

    expect($row)->not->toBeNull()
        ->and($row->new_value)->toBe('5')
        ->and((string) $row->amount_impact)->toBe('5.0000');
});

it('does not reject an order over a quantity bcmath cannot read', function (): void {
    // `is_numeric('1e2')` is true and `bccomp('1e2', …)` throws a ValueError. Thrown from inside the
    // ingest transaction, that means a client sending exponent notation does not get a warning about
    // a bad value — it gets its **order rejected**, by the audit trail. A trail that can refuse a
    // sale is worse than no trail.
    $orderUuid = (string) Str::uuid();
    $lineUuid = (string) Str::uuid();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [line($this->fx, $lineUuid)])]])->assertOk();

    push($this->fx, ['orders' => [$this->fx->orderCommand($orderUuid, [
        ['op' => 'update', 'uuid' => $lineUuid, 'qty' => '1e2'],
    ])]])
        ->assertOk()
        ->assertJsonPath('results.0.status', 'ok');
});
