<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\PayLater;

use App\Enums\CustomerAccountMoveType;
use App\Enums\OrderState;
use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use App\Models\Pos\PaymentMethod;
use App\Services\Pos\CustomerAccountLedger;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-434 / REG-208 — the running tab.
 *
 * `PaymentMethodType::CustomerAccount` and `requiresCustomer()` have both existed since the enum
 * was written and neither had a single caller: a till could take an on-account tender and the money
 * simply evaporated — the order settled, no drawer held it, and nothing recorded who owed it.
 *
 * Three properties matter here, and they are the ones a tab gets wrong in production rather than in
 * a demo. **A charge is booked once** however many times the register retries `POST /api/pos/sync`,
 * which is a path built to be retried. **Only settled sales reach a tab**, so a cashier who taps
 * "On account" and changes their mind leaves nothing on a document the customer reads. And **the
 * cache agrees with the moves**: `account_balance` is what a customer list sorts on,
 * `customer_account_moves` is what a customer disputes, and once those diverge the argument is
 * unwinnable.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession();

    $this->account = PaymentMethod::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'On account',
        'method_type' => 'customer_account',
        'is_cash_count' => false,
        'identify_customer' => true,
        'currency_id' => $this->fx->currency->getKey(),
        'sequence' => 30,
        'active' => true,
    ]);

    $this->fx->config->paymentMethods()->syncWithoutDetaching([
        $this->account->getKey() => ['sequence' => 30],
    ]);

    $this->regular = Customer::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Sofia R.',
    ]);
});

/**
 * Push one order on account.
 *
 * `$state` is a parameter because the settled gate is the whole design: the same push as a draft
 * must leave the tab untouched.
 *
 * @param  array<string, mixed>  $orderExtra
 */
function pushOnAccount(
    PosFixtures $fx,
    string $orderUuid,
    string $amount,
    ?int $customerId,
    ?int $methodId = null,
    string $paymentUuid = '',
    string $state = OrderState::Paid->value,
    string $lineUuid = '',
    array $orderExtra = [],
    array $lineExtra = [],
): TestResponse {
    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
        $fx->orderCommand(
            $orderUuid,
            [[
                'op' => 'create',
                'uuid' => $lineUuid === '' ? (string) Str::uuid() : $lineUuid,
                'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => $amount, 'discount' => '0',
                ...$lineExtra,
            ]],
            ['state' => $state, 'customer_id' => $customerId, ...$orderExtra],
            [[
                'op' => 'create',
                'uuid' => $paymentUuid === '' ? (string) Str::uuid() : $paymentUuid,
                'payment_method_id' => $methodId ?? test()->account->getKey(),
                'amount' => $amount,
            ]],
        ),
    ]]);
}

describe('charging a tab', function (): void {
    it('books the charge and moves the balance on the customer record', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        $move = CustomerAccountMove::query()->where('customer_id', $this->regular->getKey())->sole();

        expect($move->move_type)->toBe(CustomerAccountMoveType::Charge)
            ->and((string) $move->amount)->toBe('12.1000')
            ->and((string) $move->balance_after)->toBe('12.1000')
            ->and((string) $this->regular->refresh()->account_balance)->toBe('12.1000');
    });

    it('books one charge however many times the same order is pushed', function (): void {
        // The register retries on any network wobble and `sync` is a pure upsert, so this is the
        // ordinary case rather than an edge one. A tab that grows per retry is the whole failure.
        $orderUuid = (string) Str::uuid();
        $paymentUuid = (string) Str::uuid();
        $lineUuid = (string) Str::uuid();

        foreach (range(1, 3) as $ignored) {
            pushOnAccount(
                $this->fx, $orderUuid, '12.10', $this->regular->getKey(),
                paymentUuid: $paymentUuid, lineUuid: $lineUuid,
            )->assertOk();
        }

        expect(CustomerAccountMove::query()->count())->toBe(1)
            ->and((string) $this->regular->refresh()->account_balance)->toBe('12.1000');
    });

    it('accumulates across separate orders', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();
        pushOnAccount($this->fx, (string) Str::uuid(), '7.90', $this->regular->getKey())->assertOk();

        expect((string) $this->regular->refresh()->account_balance)->toBe('20.0000');

        $balances = CustomerAccountMove::query()->orderBy('id')->pluck('balance_after')
            ->map(static fn (mixed $v): string => (string) $v)->all();

        // `balance_after` is a running total, not a repeat of `amount` — the thing that lets a
        // statement print without replaying the table.
        expect($balances)->toBe(['12.1000', '20.0000']);
    });

    it('leaves every other tender alone', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey(), $this->fx->cash->getKey())
            ->assertOk();

        expect(CustomerAccountMove::query()->count())->toBe(0)
            ->and((string) $this->regular->refresh()->account_balance)->toBe('0.0000');
    });

    it('refuses an on-account tender with nobody to bill', function (): void {
        // Without this the order settles, no drawer took the money and no tab carries it. The enum
        // has advertised `requiresCustomer()` since it was written and nothing ever asked.
        $response = pushOnAccount($this->fx, (string) Str::uuid(), '12.10', null)->assertOk();

        expect($response->json('results.0.payments.0.status'))->toBe('rejected')
            ->and($response->json('results.0.payments.0.code'))->toBe('account_needs_customer')
            ->and(CustomerAccountMove::query()->count())->toBe(0);
    });
});

describe('only settled sales reach a tab', function (): void {
    it('ignores a draft order carrying an on-account line', function (): void {
        // A cashier who taps "On account" and then changes their mind must not leave a charge and a
        // correction on a document the customer reads. Nothing is owed until the sale is made.
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey(), state: OrderState::Draft->value)
            ->assertOk();

        expect(CustomerAccountMove::query()->count())->toBe(0)
            ->and((string) $this->regular->refresh()->account_balance)->toBe('0.0000');
    });

    it('books the charge when a draft that was already pushed is later settled', function (): void {
        // The reason the charge is swept after the order is final rather than hooked onto the
        // payment command: the register may push the payment in one batch and the state change that
        // settles the order in the next, and a hook on the payment would never fire for the second.
        $orderUuid = (string) Str::uuid();
        $paymentUuid = (string) Str::uuid();
        $lineUuid = (string) Str::uuid();

        pushOnAccount(
            $this->fx, $orderUuid, '12.10', $this->regular->getKey(),
            paymentUuid: $paymentUuid, state: OrderState::Draft->value, lineUuid: $lineUuid,
        )->assertOk();

        expect(CustomerAccountMove::query()->count())->toBe(0);

        // The settling push carries no payment commands at all — only the new state.
        test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [[
            'uuid' => $orderUuid,
            'op' => 'upsert',
            'order' => ['session_id' => $this->fx->session?->getKey(), 'state' => OrderState::Paid->value],
            'lines' => [],
            'payments' => [],
        ]]])->assertOk();

        expect(CustomerAccountMove::query()->count())->toBe(1)
            ->and((string) $this->regular->refresh()->account_balance)->toBe('12.1000');
    });

    it('lowers the tab when an on-account sale is refunded', function (): void {
        // A refund order's payment is negative and goes through the same charge path, so the tab
        // comes down without a second code path deciding the sign — and without a `reversal` case
        // that nothing could ever write.
        $originalUuid = (string) Str::uuid();
        $lineUuid = (string) Str::uuid();

        pushOnAccount($this->fx, $originalUuid, '12.10', $this->regular->getKey(), lineUuid: $lineUuid)->assertOk();

        expect((string) $this->regular->refresh()->account_balance)->toBe('12.1000');

        test()->withHeaders($this->fx->headers())->postJson('/api/pos/sync', ['orders' => [
            $this->fx->orderCommand(
                (string) Str::uuid(),
                [[
                    'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $this->fx->variant->getKey(),
                    'qty' => '-1', 'price_unit' => '12.10', 'discount' => '0',
                    'refunded_line_uuid' => $lineUuid,
                ]],
                [
                    'state' => OrderState::Paid->value,
                    'customer_id' => $this->regular->getKey(),
                    'is_refund' => true,
                    'refunded_order_uuid' => $originalUuid,
                ],
                [[
                    'op' => 'create', 'uuid' => (string) Str::uuid(),
                    'payment_method_id' => $this->account->getKey(), 'amount' => '-12.10',
                ]],
            ),
        ]])->assertOk();

        expect((string) $this->regular->refresh()->account_balance)->toBe('0.0000');
    });
});

describe('settling a tab', function (): void {
    it('takes money off the balance and returns the statement', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        $response = test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", [
                'amount' => '10.00',
                'payment_method_id' => $this->fx->cash->getKey(),
            ])->assertCreated();

        expect($response->json('balance'))->toBe('2.1000')
            ->and($response->json('ledger_balance'))->toBe('2.1000')
            ->and((string) $this->regular->refresh()->account_balance)->toBe('2.1000');
    });

    it('books the settlement negative, because positive means owed', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '10.00'])
            ->assertCreated();

        expect((string) CustomerAccountMove::query()->where('move_type', 'settlement')->sole()->amount)
            ->toBe('-10.0000');
    });

    it('lets a customer overpay into credit rather than refusing it', function (): void {
        // A real state for a regular who rounds up, and not an error to reject: the house simply
        // owes them. Refusing would mean the cashier has to make change out of nothing.
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '20.00'])
            ->assertCreated();

        expect((string) $this->regular->refresh()->account_balance)->toBe('-7.9000');
    });

    it('refuses a settlement of nothing', function (): void {
        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '0'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'settlement_refused');
    });

    it('refuses exponent notation before it reaches bcmath', function (): void {
        // `is_numeric('1e2')` is true and `bccomp('1e2', …)` throws — the trap `Amount` exists for.
        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '1e2'])
            ->assertStatus(422);
    });

    it('will not let a device settle another company customer', function (): void {
        // `BelongsToCompany` is opt-in, so route binding resolves the row perfectly happily and
        // nothing else on this path would notice.
        $stranger = Customer::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => PosFixtures::make()->company->getKey(),
            'name' => 'Someone else',
        ]);

        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$stranger->uuid}/account/settle", ['amount' => '5.00'])
            ->assertNotFound();

        expect(CustomerAccountMove::query()->count())->toBe(0);
    });
});

describe('a tab belongs to one company (review of #51)', function (): void {
    it('refuses to charge a customer belonging to another company', function (): void {
        // `customers` is not globally scoped and `BelongsToCompany` is opt-in, so a positive
        // `customer_id` used to be trusted outright. Once a money ledger sat behind it, that stopped
        // being a mislabelled ticket and became one company billing another company's regular —
        // with the move filed under the *device's* company, so it was visible to the wrong tenant
        // and invisible to the one whose balance had moved.
        $stranger = Customer::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => PosFixtures::make()->company->getKey(),
            'name' => 'Other company regular',
        ]);

        $response = pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $stranger->getKey())->assertOk();

        // The foreign id is dropped, so the on-account tender has nobody to bill and is refused
        // loudly rather than charging a stranger quietly.
        expect($response->json('results.0.payments.0.status'))->toBe('rejected')
            ->and($response->json('results.0.payments.0.code'))->toBe('account_needs_customer')
            ->and(CustomerAccountMove::query()->count())->toBe(0)
            ->and((string) $stranger->refresh()->account_balance)->toBe('0.0000');
    });

    it('does not leave another company customer on the order at all', function (): void {
        $stranger = Customer::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => PosFixtures::make()->company->getKey(),
            'name' => 'Other company regular',
        ]);

        $orderUuid = (string) Str::uuid();

        pushOnAccount($this->fx, $orderUuid, '12.10', $stranger->getKey(), $this->fx->cash->getKey())->assertOk();

        expect(Order::query()->where('uuid', $orderUuid)->value('customer_id'))->toBeNull();
    });

    it('still accepts this company own customer', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        expect((string) $this->regular->refresh()->account_balance)->toBe('12.1000');
    });

    it('refuses at the ledger too, not only at the sync boundary', function (): void {
        // Defence in depth, and it needs its own test for the same reason the unique index did:
        // the sync check filters every foreign customer out before `charge()` ever sees one, so
        // removing this guard breaks no other test. Reached here by putting the order into the
        // state the sync path refuses to produce, then asking the ledger directly.
        $ledger = app(CustomerAccountLedger::class);

        $orderUuid = (string) Str::uuid();
        pushOnAccount($this->fx, $orderUuid, '12.10', $this->regular->getKey())->assertOk();

        $stranger = Customer::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => PosFixtures::make()->company->getKey(),
            'name' => 'Other company regular',
        ]);

        CustomerAccountMove::query()->delete();
        $this->regular->forceFill(['account_balance' => '0'])->save();

        /** @var Order $order */
        $order = Order::query()->where('uuid', $orderUuid)->sole();
        $order->forceFill(['customer_id' => $stranger->getKey()])->save();

        $ledger->syncOrder($order->refresh());

        expect(CustomerAccountMove::query()->count())->toBe(0)
            ->and((string) $stranger->refresh()->account_balance)->toBe('0.0000');
    });

    it('files the move under the customer company, not the device one', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        $move = CustomerAccountMove::query()->sole();

        expect((int) $move->company_id)->toBe((int) $this->regular->company_id);
    });
});

describe('the cache and the ledger', function (): void {
    it('keeps account_balance equal to the sum of the moves through a full cycle', function (): void {
        // The invariant the whole design rests on.
        $ledger = app(CustomerAccountLedger::class);

        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();
        pushOnAccount($this->fx, (string) Str::uuid(), '7.90', $this->regular->getKey())->assertOk();

        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '5.00'])
            ->assertCreated();

        $customer = $this->regular->refresh();

        expect((string) $customer->account_balance)->toBe('15.0000')
            ->and($ledger->balance($customer))->toBe('15.0000');
    });

    it('refuses a second move against the same payment in the database itself', function (): void {
        // The service filters retries out before they reach here, so removing that filter breaks no
        // test — which is exactly why this one goes at the constraint instead. Under two devices
        // pushing the same order at once, the index is the only thing that makes "one move per
        // payment" true, and an index nothing asserts is an index that can be dropped by accident.
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        $existing = CustomerAccountMove::query()->sole();

        expect(fn () => CustomerAccountMove::query()->create([
            'company_id' => $existing->company_id,
            'customer_id' => $existing->customer_id,
            'move_type' => CustomerAccountMoveType::Charge->value,
            'amount' => '12.1000',
            'balance_after' => '24.2000',
            'pos_payment_id' => $existing->pos_payment_id,
            'occurred_at' => now(),
        ]))->toThrow(QueryException::class);
    });

    it('reads the tab back as a statement, newest first', function (): void {
        pushOnAccount($this->fx, (string) Str::uuid(), '12.10', $this->regular->getKey())->assertOk();

        test()->withHeaders($this->fx->headers())
            ->postJson("/api/pos/customers/{$this->regular->uuid}/account/settle", ['amount' => '2.10'])
            ->assertCreated();

        $response = test()->withHeaders($this->fx->headers())
            ->getJson("/api/pos/customers/{$this->regular->uuid}/account")
            ->assertOk();

        expect($response->json('moves.0.move_type'))->toBe('settlement')
            ->and($response->json('moves.1.move_type'))->toBe('charge')
            ->and($response->json('balance'))->toBe('10.0000');
    });
});
