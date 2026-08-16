<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\ApprovalLineBinding;

use App\Enums\OrderState;
use App\Models\Pos\OrderLine;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-515 / REG-045 — an approval covers the line the manager was standing in front of.
 *
 * BAN-430 made the server check that a manager override was real: the ability exists, the approver
 * works here, the approver holds it, and the approval has not already been spent on another order.
 * What it could not check was *which line* — `approval.ts` hardcoded `context: {}`, so the only
 * binding the client asserted was the order.
 *
 * One approval therefore unlocked the ability for every line in the push. Probed during that
 * review, with `restrict_price_control` on:
 *
 *     catalogue 10.00; three lines each asking 0.01 under ONE approval
 *       stored: 0.0100, 0.0100, 0.0100
 *
 * A manager approved one price override and three lines took it. That is wider than the button
 * they pressed, and it was recorded as a deliberate limitation in `ApprovalGrant::allows()` rather
 * than left to be discovered.
 *
 * The fallback is the part worth reading twice: an approval that names **no** line stays
 * order-scoped. A client that has not been updated sends `context: {}` for approvals that are
 * perfectly genuine, and a server inventing a binding the client never asserted would refuse them.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make(['restrict_price_control' => true])->withSession();
});

/**
 * An approval claim as `persistence.ts` sends one. `$lineUuid` null means the old shape — no
 * context at all — which is exactly what every client before this change produced.
 *
 * @return array<string, mixed>
 */
function claim(string $ability, int $employeeId, ?string $lineUuid = null): array
{
    return [
        'uuid' => (string) Str::uuid(),
        'ability' => $ability,
        'manager_employee_id' => $employeeId,
        'verified' => 'online',
        'at' => now()->toIso8601ZuluString(),
        'context' => $lineUuid === null ? [] : ['line_uuid' => $lineUuid],
    ];
}

/**
 * Push several lines at a manual price under the given approvals.
 *
 * @param  list<string>  $lineUuids
 * @param  list<array<string, mixed>>  $approvals
 */
function pushManualPrices(PosFixtures $fx, array $lineUuids, string $price, array $approvals, ?int $employeeId): TestResponse
{
    $command = $fx->orderCommand(
        (string) Str::uuid(),
        array_map(static fn (string $uuid): array => [
            'op' => 'create', 'uuid' => $uuid, 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => $price, 'discount' => '0',
            'price_type' => 'manual',
        ], $lineUuids),
        ['state' => OrderState::Draft->value],
    );
    $command['approvals'] = $approvals;

    return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'employee_id' => $employeeId,
        'orders' => [$command],
    ]);
}

/** @return array<string, string> line uuid => stored price */
function storedPrices(): array
{
    return OrderLine::query()->pluck('price_unit', 'uuid')
        ->map(static fn (mixed $v): string => (string) $v)
        ->all();
}

/** @return list<array<string, mixed>> */
function warnings(TestResponse $response): array
{
    return (array) $response->json('results.0.warnings');
}

describe('an approval that names a line', function (): void {
    it('authorises that line and no other in the same push', function (): void {
        // The probe from the BAN-430 review, now with the manager naming the line they approved.
        [$approved, $other, $third] = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];

        pushManualPrices(
            $this->fx,
            [$approved, $other, $third],
            '0.01',
            [claim('line.price_override', (int) $this->fx->manager->getKey(), $approved)],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        // The approved line keeps the manual price; the other two are repriced to the catalogue.
        expect($prices[$approved])->toBe('0.0100')
            ->and($prices[$other])->toBe('10.0000')
            ->and($prices[$third])->toBe('10.0000');
    });

    it('records the refusal against the lines it did not cover', function (): void {
        [$approved, $other] = [(string) Str::uuid(), (string) Str::uuid()];

        $response = pushManualPrices(
            $this->fx,
            [$approved, $other],
            '0.01',
            [claim('line.price_override', (int) $this->fx->manager->getKey(), $approved)],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $refused = array_values(array_filter(
            warnings($response),
            static fn (array $w): bool => ($w['code'] ?? '') === 'price_override_refused',
        ));

        expect($refused)->toHaveCount(1)
            ->and($refused[0]['line_uuid'])->toBe($other)
            // "A manager approved a price override" and "a manager approved *this* one" are
            // different facts. Without the reason the response reads as though the manager was
            // ignored outright.
            ->and($refused[0]['reason'])->toBe('approval_names_another_line');
    });

    it('says nothing about a mismatch when there was no approval at all', function (): void {
        // The ordinary "nobody authorised this" case needs no elaboration.
        $response = pushManualPrices(
            $this->fx,
            [(string) Str::uuid()],
            '0.01',
            [],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $refused = array_values(array_filter(
            warnings($response),
            static fn (array $w): bool => ($w['code'] ?? '') === 'price_override_refused',
        ));

        expect($refused)->toHaveCount(1)
            ->and($refused[0]['reason'])->toBeNull();
    });

    it('covers several lines when the manager approved each of them', function (): void {
        [$one, $two, $three] = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];

        pushManualPrices(
            $this->fx,
            [$one, $two, $three],
            '0.01',
            [
                claim('line.price_override', (int) $this->fx->manager->getKey(), $one),
                claim('line.price_override', (int) $this->fx->manager->getKey(), $two),
            ],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        expect($prices[$one])->toBe('0.0100')
            ->and($prices[$two])->toBe('0.0100')
            ->and($prices[$three])->toBe('10.0000');
    });
});

describe('one approval is one thing the manager agreed to (review of #55)', function (): void {
    it('refuses the same approval re-sent naming another line', function (): void {
        // The hole this feature had. `replayed()` asks whether an approval was spent on a
        // *different order* and deliberately permits re-sending it with its own — the register
        // re-pushes on every edit. So copying the row and naming a different line each time put
        // one manager approval across three lines. Probed at three; all three took the price.
        //
        // And `recordApprovals()` skips a uuid already on the trail, so the audit log showed the
        // manager approving once while three lines took it — the same way the dedupe hid
        // thirty-nine cross-order replays before BAN-430 closed that.
        $shared = (string) Str::uuid();
        [$a, $b, $c] = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];

        $copy = fn (string $line): array => [
            'uuid' => $shared,
            'ability' => 'line.price_override',
            'manager_employee_id' => (int) $this->fx->manager->getKey(),
            'verified' => 'online',
            'at' => now()->toIso8601ZuluString(),
            'context' => ['line_uuid' => $line],
        ];

        $response = pushManualPrices(
            $this->fx,
            [$a, $b, $c],
            '0.01',
            [$copy($a), $copy($b), $copy($c)],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        // The first claim stands; the copies buy nothing.
        expect($prices[$a])->toBe('0.0100')
            ->and($prices[$b])->toBe('10.0000')
            ->and($prices[$c])->toBe('10.0000');

        $duplicated = array_values(array_filter(
            warnings($response),
            static fn (array $w): bool => ($w['reason'] ?? '') === 'approval_duplicated',
        ));

        // Reported, not silently dropped: a device sending the same approval three times is the
        // single most interesting thing this mechanism can see.
        expect($duplicated)->toHaveCount(2);
    });

    it('refuses a duplicate even when it names the same line', function (): void {
        $shared = (string) Str::uuid();
        $line = (string) Str::uuid();

        $copy = fn (): array => [
            'uuid' => $shared,
            'ability' => 'line.price_override',
            'manager_employee_id' => (int) $this->fx->manager->getKey(),
            'verified' => 'online',
            'at' => now()->toIso8601ZuluString(),
            'context' => ['line_uuid' => $line],
        ];

        $response = pushManualPrices($this->fx, [$line], '0.01', [$copy(), $copy()], (int) $this->fx->cashier->getKey())
            ->assertOk();

        // Harmless in effect — the line was approved either way — but the count still has to be
        // right, because the trail is what says how many overrides a manager granted.
        expect(storedPrices()[$line])->toBe('0.0100');

        $duplicated = array_values(array_filter(
            warnings($response),
            static fn (array $w): bool => ($w['reason'] ?? '') === 'approval_duplicated',
        ));

        expect($duplicated)->toHaveCount(1);
    });

    it('grants nothing when the context names a line that is not on the order', function (): void {
        // A forged context cannot widen an approval — it only wastes it.
        [$a, $b] = [(string) Str::uuid(), (string) Str::uuid()];

        pushManualPrices(
            $this->fx,
            [$a, $b],
            '0.01',
            [claim('line.price_override', (int) $this->fx->manager->getKey(), (string) Str::uuid())],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        expect($prices[$a])->toBe('10.0000')->and($prices[$b])->toBe('10.0000');
    });
});

describe('an approval that names no line', function (): void {
    it('still authorises the whole order, as an older client expects', function (): void {
        // The compatibility case, and the reason this is not "match the line or refuse". A client
        // that has not been updated sends `context: {}` for approvals that are perfectly genuine.
        [$one, $two] = [(string) Str::uuid(), (string) Str::uuid()];

        pushManualPrices(
            $this->fx,
            [$one, $two],
            '0.01',
            [claim('line.price_override', (int) $this->fx->manager->getKey())],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        expect($prices[$one])->toBe('0.0100')->and($prices[$two])->toBe('0.0100');
    });

    it('is not narrowed by a line-scoped approval arriving beside it', function (): void {
        // Two approvals mean the manager pressed the button twice. The wider one stands — narrowing
        // it would refuse a line the manager explicitly authorised order-wide.
        [$named, $other] = [(string) Str::uuid(), (string) Str::uuid()];

        pushManualPrices(
            $this->fx,
            [$named, $other],
            '0.01',
            [
                claim('line.price_override', (int) $this->fx->manager->getKey()),
                claim('line.price_override', (int) $this->fx->manager->getKey(), $named),
            ],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $prices = storedPrices();

        expect($prices[$named])->toBe('0.0100')->and($prices[$other])->toBe('0.0100');
    });
});

describe('the discount cap', function (): void {
    /** @param list<array<string, mixed>> $approvals */
    function pushDiscounts(PosFixtures $fx, array $lineUuids, string $discount, array $approvals, ?int $employeeId): TestResponse
    {
        $command = $fx->orderCommand(
            (string) Str::uuid(),
            array_map(static fn (string $uuid): array => [
                'op' => 'create', 'uuid' => $uuid, 'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => $discount,
            ], $lineUuids),
            ['state' => OrderState::Draft->value],
        );
        $command['approvals'] = $approvals;

        return test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
            'employee_id' => $employeeId,
            'orders' => [$command],
        ]);
    }

    it('lets the approved line past the cap and cuts the rest back', function (): void {
        // Approve one 90 % discount and every line in the push used to carry one.
        [$approved, $other] = [(string) Str::uuid(), (string) Str::uuid()];

        pushDiscounts(
            $this->fx,
            [$approved, $other],
            '90',
            [claim('line.discount.above_limit', (int) $this->fx->manager->getKey(), $approved)],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $discounts = OrderLine::query()->pluck('discount_percent', 'uuid')
            ->map(static fn (mixed $v): string => (string) $v)->all();

        expect($discounts[$approved])->toBe('90.0000')
            ->and($discounts[$other])->toBe('30.0000');
    });

    it('names the mismatch on the line it did not cover', function (): void {
        [$approved, $other] = [(string) Str::uuid(), (string) Str::uuid()];

        $response = pushDiscounts(
            $this->fx,
            [$approved, $other],
            '90',
            [claim('line.discount.above_limit', (int) $this->fx->manager->getKey(), $approved)],
            (int) $this->fx->cashier->getKey(),
        )->assertOk();

        $refused = array_values(array_filter(
            warnings($response),
            static fn (array $w): bool => ($w['code'] ?? '') === 'discount_above_limit_refused',
        ));

        expect($refused)->toHaveCount(1)
            ->and($refused[0]['line_uuid'])->toBe($other)
            ->and($refused[0]['reason'])->toBe('approval_names_another_line');
    });
});
