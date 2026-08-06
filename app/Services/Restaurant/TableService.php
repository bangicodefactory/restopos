<?php

declare(strict_types=1);

namespace App\Services\Restaurant;

use App\Enums\MergeType;
use App\Enums\OrderState;
use App\Events\Restaurant\TableStateChanged;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\OrderCourse;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Services\Kitchen\PreparationService;
use App\Services\Pos\SequenceService;
use DomainException;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Str;

/**
 * Table occupancy, transfer, merge and unmerge (spec 02 RST-050…RST-059).
 *
 * The subtle part is not moving the order — it is moving the **kitchen history**
 * with it. Every transfer and merge migrates the `order_preparation_snapshots`
 * row so the delta engine still believes those quantities were already sent.
 * Skipping that reprints the whole tab to the kitchen (RST-056), which is the
 * single most visible way to make a service go wrong.
 *
 * Unmerge is backed by `pos_order_merges.restore_payload`: a per-line and
 * per-course snapshot recorded *before* the merge, so a mis-drag is always
 * reversible.
 */
final readonly class TableService
{
    public function __construct(
        private ConnectionInterface $connection,
        private PreparationService $preparation,
        private SequenceService $sequences,
        private Dispatcher $events,
    ) {}

    /**
     * Move an order to another table. When the target already holds a draft
     * order the two are merged; a self-transfer is refused.
     *
     * @return array{order: Order, merged: bool, merge_id: ?int}
     */
    public function transfer(Order $order, RestaurantTable $target, ?int $employeeId = null): array
    {
        if ((int) $order->restaurant_table_id === (int) $target->getKey()) {
            throw new DomainException('The order is already on that table.');
        }

        return $this->connection->transaction(function () use ($order, $target, $employeeId): array {
            $sourceTableId = $order->restaurant_table_id === null ? null : (int) $order->restaurant_table_id;

            /** @var Order|null $existing */
            $existing = Order::query()
                ->where('restaurant_table_id', $target->getKey())
                ->where('state', OrderState::Draft->value)
                ->whereKeyNot($order->getKey())
                ->orderBy('id')
                ->lockForUpdate()
                ->first();

            if ($existing !== null) {
                $mergeId = $this->mergeInto($order, $existing, MergeType::OrderTransfer, $employeeId);

                $this->emit($existing);
                $this->emitTable($order, $sourceTableId);

                return ['order' => $existing->refresh(), 'merged' => true, 'merge_id' => $mergeId];
            }

            $order->forceFill([
                'restaurant_table_id' => $target->getKey(),
                'guest_count' => max((int) $order->guest_count, 1),
            ])->save();

            $this->emit($order);
            $this->emitTable($order, $sourceTableId);

            return ['order' => $order, 'merged' => false, 'merge_id' => null];
        });
    }

    /**
     * Merge `$source` into `$target` and delete the source (RST-055).
     * Guest counts add up, courses are matched by index, and the print history
     * is combined so nothing is re-fired.
     */
    public function merge(Order $source, Order $target, ?int $employeeId = null): int
    {
        if ((int) $source->getKey() === (int) $target->getKey()) {
            throw new DomainException('An order cannot be merged into itself.');
        }

        return $this->connection->transaction(function () use ($source, $target, $employeeId): int {
            $id = $this->mergeInto($source, $target, MergeType::OrderMerge, $employeeId);

            $this->emit($target);

            return $id;
        });
    }

    /**
     * Restore a merge: the recorded lines and courses are recreated on a new
     * draft order on the original table (RST-052).
     */
    public function unmerge(int $mergeId, ?int $employeeId = null): Order
    {
        return $this->connection->transaction(function () use ($mergeId): Order {
            $record = $this->connection->table('pos_order_merges')->where('id', $mergeId)->lockForUpdate()->first();

            if ($record === null || $record->reverted_at !== null) {
                throw new DomainException('This merge has already been reverted.');
            }

            /** @var array{order: array<string, mixed>, lines: list<array<string, mixed>>, courses: list<array<string, mixed>>, prep: ?array<string, mixed>} $payload */
            $payload = json_decode((string) $record->restore_payload, true);

            /** @var Order $target */
            $target = Order::query()->findOrFail($record->target_order_id);

            /** @var Order $restored */
            $restored = Order::query()->create([
                ...$payload['order'],
                'uuid' => (string) Str::uuid(),
                'id' => null,
                'name' => null,
                'sequence_number' => null,
                'access_token' => (string) Str::uuid(),
                // A fresh number, not the one in the restore payload. The merge soft-deleted the
                // source, and a soft-deleted row keeps its number under
                // `pos_orders_session_tracking_unique` — so restoring the original number collides
                // with the row it was copied from and fails the unmerge outright (BAN-506).
                'tracking_number' => $this->sequences->availableTrackingNumber($target->session()->first()),
                'state' => OrderState::Draft->value,
                'restaurant_table_id' => $record->source_table_id,
                'ordered_at' => now(),
            ]);

            $courseMap = [];

            foreach ($payload['courses'] as $course) {
                /** @var OrderCourse $created */
                $created = OrderCourse::query()->create([
                    ...$course,
                    'id' => null,
                    'uuid' => (string) Str::uuid(),
                    'pos_order_id' => $restored->getKey(),
                ]);
                $courseMap[(int) ($course['id'] ?? 0)] = (int) $created->getKey();
            }

            foreach ($payload['lines'] as $line) {
                $movedId = $line['moved_line_id'] ?? null;

                if ($movedId !== null) {
                    OrderLine::query()->whereKey($movedId)->update([
                        'pos_order_id' => $restored->getKey(),
                        'restaurant_course_id' => $courseMap[(int) ($line['restaurant_course_id'] ?? 0)] ?? null,
                    ]);
                }
            }

            if ($payload['prep'] !== null) {
                $this->preparation->restoreSnapshot($restored, $payload['prep']);
            }

            $this->connection->table('pos_order_merges')->where('id', $mergeId)->update([
                'reverted_at' => now(),
                'updated_at' => now(),
            ]);

            $this->emit($restored);
            $this->emit($target);

            return $restored;
        });
    }

    /** Guest count, minimum 1 when a table is attached (RST-070). */
    public function setGuestCount(Order $order, int $guests): Order
    {
        if ($guests < 0) {
            throw new DomainException('Guest count cannot be negative.');
        }

        $order->forceFill(['guest_count' => $guests])->save();

        $this->emit($order);

        return $order;
    }

    /**
     * Physical table linking: the child snaps to the parent and its open order
     * merges into the parent's (RST-050 / RST-051). Cycle-guarded.
     */
    public function link(RestaurantTable $child, ?RestaurantTable $parent, ?int $employeeId = null): RestaurantTable
    {
        if ($parent !== null) {
            if ((int) $parent->getKey() === (int) $child->getKey()) {
                throw new DomainException('A table cannot be linked to itself.');
            }

            $cursor = $parent;
            $depth = 0;
            while ($cursor->parent_id !== null && $depth++ < 10) {
                if ((int) $cursor->parent_id === (int) $child->getKey()) {
                    throw new DomainException('That link would create a cycle.');
                }
                $cursor = RestaurantTable::query()->find($cursor->parent_id) ?? $cursor;
            }
        }

        return $this->connection->transaction(function () use ($child, $parent, $employeeId): RestaurantTable {
            $child->forceFill(['parent_id' => $parent?->getKey()])->save();

            if ($parent !== null) {
                /** @var Order|null $childOrder */
                $childOrder = Order::query()
                    ->where('restaurant_table_id', $child->getKey())
                    ->where('state', OrderState::Draft->value)
                    ->orderBy('id')
                    ->first();

                /** @var Order|null $parentOrder */
                $parentOrder = Order::query()
                    ->where('restaurant_table_id', $parent->getKey())
                    ->where('state', OrderState::Draft->value)
                    ->orderBy('id')
                    ->first();

                if ($childOrder !== null && $parentOrder !== null) {
                    $this->mergeInto($childOrder, $parentOrder, MergeType::TableLink, $employeeId);
                } elseif ($childOrder !== null) {
                    $childOrder->forceFill(['restaurant_table_id' => $parent->getKey()])->save();
                }
            }

            return $child;
        });
    }

    /**
     * Two devices claiming the same table: the **oldest** server-side draft wins
     * and the loser's lines move onto it (spec 03 §3.6.5). Atomic under a lock
     * on the table row.
     */
    public function resolveDuplicateTableOrders(int $tableId, ?int $employeeId = null): ?Order
    {
        return $this->connection->transaction(function () use ($tableId, $employeeId): ?Order {
            RestaurantTable::query()->whereKey($tableId)->lockForUpdate()->first();

            /** @var list<Order> $drafts */
            $drafts = Order::query()
                ->where('restaurant_table_id', $tableId)
                ->where('state', OrderState::Draft->value)
                ->orderBy('id')
                ->lockForUpdate()
                ->get()
                ->all();

            if (count($drafts) < 2) {
                return $drafts[0] ?? null;
            }

            $winner = array_shift($drafts);

            foreach ($drafts as $loser) {
                $this->mergeInto($loser, $winner, MergeType::OrderMerge, $employeeId);
            }

            return $winner->refresh();
        });
    }

    // ------------------------------------------------------------- internals

    /**
     * The actual move. Returns the `pos_order_merges` id so the caller can
     * offer an undo.
     */
    private function mergeInto(Order $source, Order $target, MergeType $type, ?int $employeeId): int
    {
        /** @var list<OrderCourse> $sourceCourses */
        $sourceCourses = OrderCourse::query()->where('pos_order_id', $source->getKey())->orderBy('course_index')->get()->all();
        /** @var list<OrderLine> $sourceLines */
        $sourceLines = OrderLine::query()->where('pos_order_id', $source->getKey())->orderBy('id')->get()->all();

        $restore = [
            'order' => array_diff_key($source->attributesToArray(), array_flip(['id', 'uuid', 'created_at', 'updated_at'])),
            'lines' => [],
            'courses' => array_map(
                static fn (OrderCourse $c): array => array_diff_key($c->attributesToArray(), array_flip(['created_at', 'updated_at'])),
                $sourceCourses,
            ),
            'prep' => $this->preparation->snapshotPayload($source),
        ];

        // Courses are re-parented by matching `course_index`; an index with no
        // counterpart on the target is created there (RST-089).
        $targetCourses = OrderCourse::query()
            ->where('pos_order_id', $target->getKey())
            ->get()
            ->keyBy(fn (OrderCourse $c): int => (int) $c->course_index);

        $courseMap = [];

        foreach ($sourceCourses as $course) {
            $index = (int) $course->course_index;
            $match = $targetCourses->get($index);

            if ($match === null) {
                /** @var OrderCourse $match */
                $match = OrderCourse::query()->create([
                    'uuid' => (string) Str::uuid(),
                    'pos_order_id' => $target->getKey(),
                    'course_index' => $index,
                    'name' => $course->name,
                    'fired' => (bool) $course->fired,
                    'fired_at' => $course->fired_at,
                ]);
                $targetCourses->put($index, $match);
            }

            $courseMap[(int) $course->getKey()] = (int) $match->getKey();
        }

        foreach ($sourceLines as $line) {
            $restore['lines'][] = [
                'moved_line_id' => (int) $line->getKey(),
                'uuid' => (string) $line->uuid,
                'quantity' => (string) $line->quantity,
                'restaurant_course_id' => $line->restaurant_course_id === null ? null : (int) $line->restaurant_course_id,
            ];

            $line->forceFill([
                'pos_order_id' => $target->getKey(),
                'restaurant_course_id' => $line->restaurant_course_id === null
                    ? null
                    : ($courseMap[(int) $line->restaurant_course_id] ?? null),
            ])->save();
        }

        // The kitchen must not see any of this as new work.
        $this->preparation->mergeSnapshots($source, $target);

        $target->forceFill([
            'guest_count' => (int) $target->guest_count + (int) $source->guest_count,
        ])->save();

        $mergeId = (int) $this->connection->table('pos_order_merges')->insertGetId([
            'uuid' => (string) Str::uuid(),
            'source_order_id' => $source->getKey(),
            'target_order_id' => $target->getKey(),
            'source_table_id' => $source->restaurant_table_id,
            'merge_type' => $type->value,
            'restore_payload' => json_encode($restore),
            'prep_history_payload' => json_encode($restore['prep']),
            'performed_by_employee_id' => $employeeId,
            'performed_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        OrderCourse::query()->where('pos_order_id', $source->getKey())->delete();
        $source->forceFill(['merged_into_order_id' => $target->getKey()])->save();
        $source->delete();

        return $mergeId;
    }

    private function emit(Order $order): void
    {
        $config = PosConfig::query()->find($order->pos_config_id);

        if ($config === null || $order->restaurant_table_id === null) {
            return;
        }

        $this->emitTable($order, (int) $order->restaurant_table_id, $config);
    }

    private function emitTable(Order $order, ?int $tableId, ?PosConfig $config = null): void
    {
        if ($tableId === null) {
            return;
        }

        $config ??= PosConfig::query()->find($order->pos_config_id);

        if ($config === null) {
            return;
        }

        $row = $this->connection->table('pos_orders')
            ->where('restaurant_table_id', $tableId)
            ->where('state', OrderState::Draft->value)
            ->whereNull('deleted_at')
            ->selectRaw('count(*) as order_count')
            ->selectRaw('coalesce(sum(guest_count), 0) as guest_count')
            ->selectRaw('coalesce(sum(amount_total), 0) as amount_total')
            ->first();

        $childIds = RestaurantTable::query()->where('parent_id', $tableId)->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        $this->events->dispatch(new TableStateChanged(
            configToken: (string) $config->access_token,
            tableId: $tableId,
            occupied: (int) ($row->order_count ?? 0) > 0,
            orderCount: (int) ($row->order_count ?? 0),
            guestCount: (int) ($row->guest_count ?? 0),
            amountTotal: (string) ($row->amount_total ?? '0'),
            orderUuid: (string) $order->uuid,
            childTableIds: $childIds,
        ));
    }
}
