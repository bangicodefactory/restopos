<?php

declare(strict_types=1);

// Own namespace so the helpers below stay out of the global function table Pest shares across every
// test file — a collision there is a fatal error that only surfaces on a full-suite run.

namespace Tests\Feature\Pos\SessionSequence;

use App\Enums\OrderState;
use App\Enums\SequencePurpose;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosSession;
use App\Models\Pos\Sequence;
use App\Services\Pos\SequenceService;
use App\Services\Pos\SessionService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-442 — numbers that are allocated, not counted.
 *
 * Both defects were the same mistake in two places: asking "how many are there?" and using the
 * answer as "what is the next one?". A count is only the next number when nothing is ever removed
 * and nobody else is asking at the same time, and neither holds on a till.
 *
 * Session names: two devices opening at the same instant counted the same rows and produced the
 * same name. Line numbers: deleting any line freed its number for reuse, so the receipt and the
 * kitchen ticket could carry two different products both calling themselves line 3 — the index on
 * (`pos_order_id`, `line_number`) is not unique, so nothing downstream noticed.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make(['has_cash_control' => false]);
});

describe('session names are allocated', function (): void {
    it('hands out consecutive names', function (): void {
        $sequences = app(SequenceService::class);

        expect($sequences->nextSessionName($this->fx->config))->toBe('Bar/00001')
            ->and($sequences->nextSessionName($this->fx->config))->toBe('Bar/00002')
            ->and($sequences->nextSessionName($this->fx->config))->toBe('Bar/00003');
    });

    it('never repeats a name, whatever happens to the sessions that used one', function (): void {
        // The count-based version derived the next name from the rows that still had one, so
        // clearing a name — a cancelled opening control, a purge — handed the same number out
        // twice. An allocator does not care what happened to what it already issued.
        $sequences = app(SequenceService::class);

        $first = $sequences->nextSessionName($this->fx->config);
        $second = $sequences->nextSessionName($this->fx->config);

        PosSession::query()->update(['name' => null]);

        expect($sequences->nextSessionName($this->fx->config))->not->toBe($first)
            ->and($sequences->nextSessionName($this->fx->config))->not->toBe($second);
    });

    it('gives two registers their own runs of numbers', function (): void {
        $other = PosFixtures::make(['has_cash_control' => false]);
        $sequences = app(SequenceService::class);

        $sequences->nextSessionName($this->fx->config);
        $sequences->nextSessionName($this->fx->config);

        // Per config, not per company: two tills in one restaurant each number their own shifts.
        expect($sequences->nextSessionName($other->config))->toEndWith('/00001');
    });

    it('names a real session through the open path', function (): void {
        $session = app(SessionService::class)->open($this->fx->config, '0');

        expect($session->name)->toBe('Bar/00001');
    });

    it('carries on from the counter rather than from the row count', function (): void {
        // The property that makes concurrent opens safe: the number comes from a row that was
        // locked and incremented, so a second caller reading at the same moment gets the next one
        // and not the same one. Simulated here by moving the counter on and checking the open
        // respects it — under real concurrency the row lock is what serialises the two reads.
        $sequences = app(SequenceService::class);
        $sequences->nextSessionName($this->fx->config);
        $sequences->nextSessionName($this->fx->config);

        $session = app(SessionService::class)->open($this->fx->config, '0');

        expect($session->name)->toBe('Bar/00003')
            ->and(PosSession::query()->count())->toBe(1);
    });

    it('follows a rename, because the prefix is derived and not stored (review of #54)', function (): void {
        // `sequences.prefix` is written once, when the row is created, so formatting through it
        // froze the register's name at whatever it was called the day it first opened. Orders
        // derive the prefix live, so the same register said `Terrace/00412` and `Bar/00013` at the
        // same time — two numbering schemes disagreeing about the name of the venue.
        $sequences = app(SequenceService::class);

        expect($sequences->nextSessionName($this->fx->config))->toBe('Bar/00001');

        $this->fx->config->forceFill(['name' => 'Terrace'])->save();

        expect($sequences->nextSessionName($this->fx->config->refresh()))->toBe('Terrace/00002');
    });

    it('keeps numbering where it left off across the rename', function (): void {
        // The counter is the row's; only the prefix is derived. A rename must not restart the run.
        $sequences = app(SequenceService::class);

        $sequences->nextSessionName($this->fx->config);
        $sequences->nextSessionName($this->fx->config);
        $this->fx->config->forceFill(['name' => 'Terrace'])->save();

        expect($sequences->nextSessionName($this->fx->config->refresh()))->toBe('Terrace/00003');
    });

    it('names sessions and orders with the same prefix', function (): void {
        // The property the frozen prefix broke: whatever a register is called, both schemes agree.
        $sequences = app(SequenceService::class);
        $this->fx->config->forceFill(['name' => 'Terrace'])->save();

        $session = $sequences->nextSessionName($this->fx->config->refresh());
        $order = $sequences->orderName($this->fx->config, 12);

        expect(explode('/', $session)[0])->toBe(explode('/', $order)[0]);
    });

    it('keeps its counter in the sequences table, where it can be read back', function (): void {
        app(SessionService::class)->open($this->fx->config, '0');

        $sequence = Sequence::query()
            ->where('pos_config_id', $this->fx->config->getKey())
            ->where('purpose', SequencePurpose::Session->value)
            ->sole();

        expect((int) $sequence->next_value)->toBe(2);
    });
});

describe('line numbers are not reused', function (): void {
    it('does not hand a deleted line number to the next line', function (): void {
        $fx = PosFixtures::make()->withSession();
        $orderUuid = (string) Str::uuid();
        $lines = [(string) Str::uuid(), (string) Str::uuid(), (string) Str::uuid()];

        test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
            $fx->orderCommand($orderUuid, array_map(static fn (string $uuid): array => [
                'op' => 'create', 'uuid' => $uuid, 'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
            ], $lines)),
        ]])->assertOk();

        // Take the middle one off. Then add a fourth in a **separate push** — which is what a
        // cashier removing a line and ringing up another actually does, and the shape that produced
        // two number 3s. Delete and create in one batch happened to come out right, because the
        // count was taken before the delete removed anything from it.
        test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [[
            'uuid' => $orderUuid,
            'op' => 'upsert',
            'order' => ['session_id' => $fx->session?->getKey()],
            'lines' => [['op' => 'delete', 'uuid' => $lines[1]]],
        ]]])->assertOk();

        test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [[
            'uuid' => $orderUuid,
            'op' => 'upsert',
            'order' => ['session_id' => $fx->session?->getKey()],
            'lines' => [[
                'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
                'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
            ]],
        ]]])->assertOk();

        $numbers = OrderLine::withTrashed()
            ->whereHas('order', static fn ($q) => $q->where('uuid', $orderUuid))
            ->orderBy('id')
            ->pluck('line_number')
            ->map(static fn (mixed $n): int => (int) $n)
            ->all();

        expect($numbers)->toBe([1, 2, 3, 4])
            ->and(count(array_unique($numbers)))->toBe(4);
    });

    it('numbers a fresh order from one', function (): void {
        $fx = PosFixtures::make()->withSession();
        $orderUuid = (string) Str::uuid();

        test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [
            $fx->orderCommand($orderUuid, [
                ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
                ['op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(), 'qty' => '1', 'price_unit' => '10.00', 'discount' => '0'],
            ]),
        ]])->assertOk();

        expect(OrderLine::query()->orderBy('id')->pluck('line_number')->map(static fn (mixed $n): int => (int) $n)->all())
            ->toBe([1, 2]);
    });

    it('carries on across separate pushes to the same order', function (): void {
        // Each push re-reads the high-water mark; the order row is locked for the whole ingest, so
        // two pushes cannot be numbering the same order at once.
        $fx = PosFixtures::make()->withSession();
        $orderUuid = (string) Str::uuid();

        foreach (range(1, 3) as $ignored) {
            test()->withHeaders($fx->headers())->postJson('/api/pos/sync', ['orders' => [[
                'uuid' => $orderUuid,
                'op' => 'upsert',
                'order' => ['session_id' => $fx->session?->getKey(), 'state' => OrderState::Draft->value],
                'lines' => [[
                    'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
                    'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
                ]],
            ]]])->assertOk();
        }

        expect(OrderLine::query()->orderBy('id')->pluck('line_number')->map(static fn (mixed $n): int => (int) $n)->all())
            ->toBe([1, 2, 3]);
    });
});
