<?php

declare(strict_types=1);

namespace App\Services\Kitchen;

use App\Enums\OrderPrepState;
use App\Enums\PrepChangeType;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrepStageType;
use App\Events\Kitchen\KitchenTicketUpdated;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use DomainException;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;

/**
 * The KDS board and its state machine (spec 02 KDS-005…KDS-021).
 *
 * Stages are **per station per item**; the card's state is the aggregate. That
 * is the only model that survives a multi-station order — an order is "ready"
 * when every station's items are ready, not when someone bumped a card.
 *
 * Every mutation is idempotent on the target state so an offline KDS can replay
 * its queued transitions on reconnect without corrupting the board.
 */
final readonly class KitchenDisplayService
{
    public function __construct(
        private ConnectionInterface $connection,
        private Dispatcher $events,
    ) {}

    /**
     * The board: active cards plus recently-served ones inside the display's
     * retention window (spec 01-schema §5.7).
     *
     * @return array<string, mixed>
     */
    public function board(PrepDisplay $display, ?string $since = null): array
    {
        $retention = (int) $display->done_retention_minutes;
        $cutoff = Carbon::now()->subMinutes($retention);

        $orders = $this->connection->table('prep_orders')
            ->where('prep_display_id', $display->getKey())
            ->where(function ($q) use ($cutoff): void {
                $q->whereIn('state', [
                    PrepOrderState::Pending->value,
                    PrepOrderState::InProgress->value,
                    PrepOrderState::Ready->value,
                ])->orWhere('served_at', '>=', $cutoff);
            })
            ->when($since !== null, fn ($q) => $q->where('updated_at', '>', $since))
            ->orderBy('fired_at')
            ->get();

        $ids = $orders->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        $lines = $ids === []
            ? collect()
            : $this->connection->table('prep_order_lines')
                ->whereIn('prep_order_id', $ids)
                ->orderBy('course_index')
                ->orderBy('id')
                ->get()
                ->groupBy('prep_order_id');

        $cards = [];

        foreach ($orders as $order) {
            $cards[] = [
                ...(array) $order,
                'age_seconds' => Carbon::parse((string) $order->fired_at)->diffInSeconds(Carbon::now()),
                'lines' => array_map(
                    static fn (object $l): array => (array) $l,
                    $lines->get($order->id, collect())->all(),
                ),
            ];
        }

        return [
            'server_time' => Carbon::now()->toIso8601ZuluString('microsecond'),
            'display' => [
                'id' => (int) $display->getKey(),
                'name' => (string) $display->name,
                'layout' => (string) ($display->layout?->value ?? $display->layout),
                'average_prep_minutes' => (int) $display->average_prep_minutes,
                'late_threshold_minutes' => (int) $display->late_threshold_minutes,
                'done_retention_minutes' => $retention,
                'sound_on_new_order' => (bool) $display->sound_on_new_order,
            ],
            'stages' => $this->stages($display),
            'orders' => $cards,
        ];
    }

    /** @return list<array<string, mixed>> */
    public function stages(PrepDisplay $display): array
    {
        return $this->connection->table('prep_stages')
            ->where('prep_display_id', $display->getKey())
            ->orderBy('sequence')
            ->get()
            ->map(static fn (object $s): array => (array) $s)
            ->all();
    }

    /**
     * Move a whole card to a stage (bump). Every line follows unless it is
     * already past the target state.
     *
     * @return array<string, mixed>
     */
    public function moveOrderToStage(PrepDisplay $display, int $prepOrderId, int $stageId, ?int $employeeId = null): array
    {
        return $this->connection->transaction(function () use ($display, $prepOrderId, $stageId, $employeeId): array {
            $stage = $this->requireStage($display, $stageId);
            $target = PrepStageType::from((string) $stage->stage_type)->toLineState();

            $lines = $this->connection->table('prep_order_lines')->where('prep_order_id', $prepOrderId)->get();

            foreach ($lines as $line) {
                // Bumping the card must not drag a cancellation along with it (KDS-016): marking
                // "don't make this" as ready or served is nonsense, and it is what made the row
                // look like work again on the next aggregate. Mirrors `applyStageLocally`.
                if ($this->isCancelled($line)) {
                    continue;
                }

                $this->transitionLine($line, $stageId, $target, $employeeId);
            }

            return $this->refreshOrderState($display, $prepOrderId);
        });
    }

    /**
     * Per-item done toggle (KDS-010). Aggregates back up to the card.
     *
     * @return array<string, mixed>
     */
    public function setLineState(PrepDisplay $display, int $prepOrderLineId, PrepLineState $state, ?int $employeeId = null): array
    {
        return $this->connection->transaction(function () use ($display, $prepOrderLineId, $state, $employeeId): array {
            $line = $this->connection->table('prep_order_lines')->where('id', $prepOrderLineId)->first();

            if ($line === null) {
                throw new DomainException('Unknown preparation line.');
            }

            $stageId = $this->stageIdForState($display, $state) ?? $line->prep_stage_id;

            $this->transitionLine($line, $stageId === null ? null : (int) $stageId, $state, $employeeId);

            return $this->refreshOrderState($display, (int) $line->prep_order_id);
        });
    }

    /**
     * Recall a bumped card (KDS-009). Manager-gated at the controller, and
     * always audited: a recall that hides a mistake is worse than the mistake.
     *
     * @return array<string, mixed>
     */
    public function recall(PrepDisplay $display, int $prepOrderId, ?int $employeeId = null): array
    {
        return $this->connection->transaction(function () use ($display, $prepOrderId, $employeeId): array {
            $todoStage = $this->connection->table('prep_stages')
                ->where('prep_display_id', $display->getKey())
                ->where('stage_type', PrepStageType::Todo->value)
                ->orderBy('sequence')
                ->value('id');

            $lines = $this->connection->table('prep_order_lines')->where('prep_order_id', $prepOrderId)->get();

            foreach ($lines as $line) {
                // A recall reopens the food, not the cancellations — putting one back to `todo`
                // resurrects "don't make this" as work to do (KDS-016). Mirrors `applyRecallLocally`.
                if ($this->isCancelled($line)) {
                    continue;
                }

                $this->transitionLine($line, $todoStage === null ? null : (int) $todoStage, PrepLineState::Todo, $employeeId);
            }

            $this->connection->table('prep_orders')->where('id', $prepOrderId)->update([
                'is_recalled' => true,
                'ready_at' => null,
                'served_at' => null,
                'updated_at' => now(),
            ]);

            return $this->refreshOrderState($display, $prepOrderId, recalled: true);
        });
    }

    // ------------------------------------------------------------- internals

    /**
     * Is this prep line a cancellation? (KDS-016)
     *
     * The server's single definition, and the mirror of `isLineCancelled` in
     * `resources/js/kitchen/logic/board.ts` — the two must stay in step, because the client renders
     * from its own copy right up until this side broadcasts and overwrites it.
     *
     * Both spellings count. A cancellation arrives as a *new* line in state `todo` carrying
     * `change_type: 'cancelled'`; it only reaches state `cancelled` if something later sets it.
     */
    private function isCancelled(object $line): bool
    {
        return (string) $line->state === PrepLineState::Cancelled->value
            || (string) $line->change_type === PrepChangeType::Cancelled->value;
    }

    private function transitionLine(object $line, ?int $stageId, PrepLineState $state, ?int $employeeId): void
    {
        $from = (string) $line->state;

        if ($from === $state->value && (int) ($line->prep_stage_id ?? 0) === (int) ($stageId ?? 0)) {
            return;
        }

        $now = Carbon::now();
        $patch = ['state' => $state->value, 'prep_stage_id' => $stageId, 'updated_at' => $now];

        $patch += match ($state) {
            PrepLineState::InProgress => ['started_at' => $line->started_at ?? $now],
            PrepLineState::Ready => ['ready_at' => $now],
            PrepLineState::Served => ['served_at' => $now],
            PrepLineState::Todo => ['started_at' => null, 'ready_at' => null, 'served_at' => null],
            default => [],
        };

        $this->connection->table('prep_order_lines')->where('id', $line->id)->update($patch);

        $this->connection->table('prep_line_stage_logs')->insert([
            'prep_order_line_id' => $line->id,
            'from_stage_id' => $line->prep_stage_id,
            'to_stage_id' => $stageId,
            'from_state' => $from,
            'to_state' => $state->value,
            'employee_id' => $employeeId,
            'moved_at' => $now,
            'duration_seconds' => $line->fired_at === null ? null : Carbon::parse((string) $line->fired_at)->diffInSeconds($now),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** @return array<string, mixed> */
    private function refreshOrderState(PrepDisplay $display, int $prepOrderId, bool $recalled = false): array
    {
        $lines = $this->connection->table('prep_order_lines')->where('prep_order_id', $prepOrderId)->get();

        // KDS-016 — a cancellation is booked as a *new* prep line in state `todo` carrying
        // `change_type: 'cancelled'`. It is the kitchen's instruction to stop cooking, not work,
        // and `all()` demands every state match — so leaving it in pinned the card at `pending`
        // whatever the cook did to the real food.
        //
        // This is the copy that matters. It persists `prep_orders.state` and broadcasts it, and the
        // client assigns that state verbatim, so a client-side fix alone is overwritten on the next
        // line move. The predicate mirrors `isLineCancelled` in resources/js/kitchen/logic/board.ts;
        // the two must stay in step.
        $active = $lines->reject(fn (object $line): bool => $this->isCancelled($line));

        $states = $active->pluck('state')->map(static fn (mixed $v): string => (string) $v)->all();

        $state = match (true) {
            // Every line cancelled: the card is cancelled, not served. `aggregateState` on the
            // client says the same — these two answer the same question and must not diverge.
            $lines->isNotEmpty() && $states === [] => PrepOrderState::Cancelled,
            $states === [] => PrepOrderState::Pending,
            $this->all($states, PrepLineState::Served->value) => PrepOrderState::Served,
            $this->all($states, PrepLineState::Ready->value) => PrepOrderState::Ready,
            $this->any($states, [PrepLineState::InProgress->value, PrepLineState::Ready->value]) => PrepOrderState::InProgress,
            default => PrepOrderState::Pending,
        };

        $now = Carbon::now();
        $patch = ['state' => $state->value, 'updated_at' => $now];

        if ($state === PrepOrderState::InProgress) {
            $patch['first_started_at'] = $this->connection->table('prep_orders')->where('id', $prepOrderId)->value('first_started_at') ?? $now;
        }
        if ($state === PrepOrderState::Ready) {
            $patch['ready_at'] = $now;
        }
        if ($state === PrepOrderState::Served) {
            $patch['served_at'] = $now;
        }

        $this->connection->table('prep_orders')->where('id', $prepOrderId)->update($patch);

        $prepOrder = $this->connection->table('prep_orders')->where('id', $prepOrderId)->first();

        if ($prepOrder !== null) {
            $this->syncOrderPrepState((int) $prepOrder->pos_order_id);

            $config = PosConfig::query()->find($prepOrder->pos_config_id);

            $this->events->dispatch(new KitchenTicketUpdated(
                displayToken: (string) $display->access_token,
                configToken: (string) ($config?->access_token ?? ''),
                prepOrderId: $prepOrderId,
                prepOrderUuid: (string) $prepOrder->uuid,
                state: $state->value,
                lines: $lines->map(static fn (object $l): array => [
                    'id' => (int) $l->id,
                    'uuid' => (string) $l->uuid,
                    'pos_order_line_uuid' => (string) $l->pos_order_line_uuid,
                    'state' => (string) $l->state,
                ])->all(),
                recalled: $recalled,
            ));
        }

        return [
            'prep_order_id' => $prepOrderId,
            'state' => $state->value,
            'lines' => $this->connection->table('prep_order_lines')
                ->where('prep_order_id', $prepOrderId)
                ->get()
                ->map(static fn (object $l): array => (array) $l)
                ->all(),
        ];
    }

    /**
     * Mirror the aggregate kitchen state back onto the POS order so the
     * register's ticket list and the customer status page can read one field.
     */
    private function syncOrderPrepState(int $posOrderId): void
    {
        $states = $this->connection->table('prep_orders')
            ->where('pos_order_id', $posOrderId)
            ->pluck('state')
            ->map(static fn (mixed $v): string => (string) $v)
            ->all();

        if ($states === []) {
            return;
        }

        // A station whose whole card was cancelled has nothing left to plate, so it must not hold
        // the order at "sent" for the register — treat it as settled alongside the served ones
        // (KDS-016). An order cancelled at *every* station reads as served rather than in-flight.
        $settled = [PrepOrderState::Served->value, PrepOrderState::Cancelled->value];
        $servedOrCancelled = array_filter($states, static fn (string $s): bool => ! in_array($s, $settled, true)) === [];

        $prepState = match (true) {
            $servedOrCancelled => OrderPrepState::Served,
            $this->all($states, PrepOrderState::Ready->value) => OrderPrepState::Ready,
            $this->any($states, [PrepOrderState::Ready->value]) => OrderPrepState::PartiallyReady,
            default => OrderPrepState::Sent,
        };

        Order::query()->whereKey($posOrderId)->update(['prep_state' => $prepState->value]);
    }

    private function requireStage(PrepDisplay $display, int $stageId): object
    {
        $stage = $this->connection->table('prep_stages')
            ->where('prep_display_id', $display->getKey())
            ->where('id', $stageId)
            ->first();

        if ($stage === null) {
            throw new DomainException('That stage does not belong to this display.');
        }

        return $stage;
    }

    private function stageIdForState(PrepDisplay $display, PrepLineState $state): ?int
    {
        $type = match ($state) {
            PrepLineState::Todo => PrepStageType::Todo,
            PrepLineState::InProgress => PrepStageType::InProgress,
            PrepLineState::Ready => PrepStageType::Ready,
            default => PrepStageType::Done,
        };

        $id = $this->connection->table('prep_stages')
            ->where('prep_display_id', $display->getKey())
            ->where('stage_type', $type->value)
            ->orderBy('sequence')
            ->value('id');

        return $id === null ? null : (int) $id;
    }

    /** @param list<string> $states */
    private function all(array $states, string $value): bool
    {
        foreach ($states as $state) {
            if ($state !== $value) {
                return false;
            }
        }

        return $states !== [];
    }

    /**
     * @param  list<string>  $states
     * @param  list<string>  $values
     */
    private function any(array $states, array $values): bool
    {
        foreach ($states as $state) {
            if (in_array($state, $values, true)) {
                return true;
            }
        }

        return false;
    }
}
