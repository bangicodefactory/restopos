<?php

declare(strict_types=1);

namespace App\Services\Kitchen;

use App\Enums\OrderPrepState;
use App\Enums\PrepChangeType;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrepStageType;
use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use App\Events\Kitchen\KitchenTicketCreated;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\OrderCourse;
use App\Services\Kitchen\Dto\PreparationChange;
use App\Services\Kitchen\Dto\PreparationDelta;
use DomainException;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * The change-delta engine (spec 02 KDS-050…KDS-062) and the ticket/print-job
 * fan-out.
 *
 * `order_preparation_snapshots` holds what the kitchen has **already been told**
 * about an order. The delta between that snapshot and the order's current lines
 * is the single source of truth for every downstream feature: unsent-change
 * badges, the "order has unsent changes" prompt, kitchen tickets and the KDS.
 *
 * The snapshot is server-authoritative on purpose. Odoo keeps it client-side
 * with a `metadata.serverDate` guard; two waiters firing the same table then
 * race and the kitchen gets the order twice. Here the server arbitrates: a send
 * whose `snapshot_version` is behind the stored one is refused with
 * `order_outdated` and the client adopts the server state instead of printing.
 */
final readonly class PreparationService
{
    /**
     * Guards the combo-parent walk in {@see inheritComboRouting()} against a cyclic parent chain.
     *
     * Untested on purpose: no code path can produce a cycle, so reaching this bound means the data
     * is already corrupt. It exists so that corruption is a missing category rather than a hung
     * send request.
     */
    private const MAX_COMBO_DEPTH = 8;

    public function __construct(
        private ConnectionInterface $connection,
        private TicketRenderer $renderer,
        private Dispatcher $events,
    ) {}

    /**
     * Compute what the kitchen has not yet seen. Pure — it writes nothing.
     */
    public function delta(Order $order, ?int $courseIndex = null): PreparationDelta
    {
        $snapshot = $this->snapshot($order);
        $current = $this->currentState($order);

        /** @var array<string, array<string, mixed>> $previous */
        $previous = (array) ($snapshot['lines'] ?? []);

        $changes = [];

        foreach ($current as $uuid => $line) {
            if ($courseIndex !== null && (int) $line['course_index'] !== $courseIndex) {
                continue;
            }

            $before = $previous[$uuid] ?? null;

            if ($before === null) {
                if (bccomp((string) $line['quantity'], '0', 3) !== 0) {
                    $changes[] = $this->change($line, (string) $line['quantity'], PrepChangeType::New);
                }

                continue;
            }

            $delta = bcsub((string) $line['quantity'], (string) $before['quantity'], 3);

            if (bccomp($delta, '0', 3) !== 0) {
                $changes[] = $this->change(
                    $line,
                    $delta,
                    bccomp($delta, '0', 3) > 0 ? PrepChangeType::New : PrepChangeType::Cancelled,
                );

                continue;
            }

            // Same quantity, different note: a note-only update. Odoo makes the
            // note part of the diff key; we surface it explicitly instead so the
            // KDS can show "note changed" rather than cancel-and-readd.
            if ((string) ($before['note'] ?? '') !== (string) ($line['note'] ?? '')
                || (string) ($before['customer_note'] ?? '') !== (string) ($line['customer_note'] ?? '')
            ) {
                $changes[] = $this->change($line, '0', PrepChangeType::NoteUpdate);
            }
        }

        // Lines that vanished entirely are cancellations of the sent quantity.
        foreach ($previous as $uuid => $before) {
            if (isset($current[$uuid])) {
                continue;
            }

            if ($courseIndex !== null && (int) ($before['course_index'] ?? 1) !== $courseIndex) {
                continue;
            }

            $changes[] = $this->change($before, '-'.ltrim((string) $before['quantity'], '-'), PrepChangeType::Cancelled);
        }

        $noteChanged = (string) ($snapshot['general_customer_note'] ?? '') !== (string) ($order->general_customer_note ?? '')
            || (string) ($snapshot['internal_note'] ?? '') !== (string) ($order->internal_note ?? '');

        return new PreparationDelta(
            orderUuid: (string) $order->uuid,
            changes: $changes,
            orderNoteChanged: $noteChanged,
            generalCustomerNote: $order->general_customer_note,
            internalNote: is_string($order->internal_note) ? $order->internal_note : null,
            snapshotVersion: (int) ($snapshot['server_version'] ?? 0),
            snapshotAt: $snapshot['server_date'] ?? null,
        );
    }

    /**
     * Fire the delta at the kitchen: create/extend prep orders on every routed
     * display, queue print jobs on every routed printer, then advance the
     * snapshot. Returns what was sent so the register can toast it.
     *
     * @return array{delta: PreparationDelta, prep_orders: list<array<string, mixed>>, print_jobs: list<int>, snapshot_version: int}
     */
    public function send(
        Order $order,
        PosConfig $config,
        ?int $courseIndex = null,
        ?int $deviceId = null,
        ?int $expectedSnapshotVersion = null,
    ): array {
        // Cross-device guard (KDS-057). Checked *before* the transaction opens,
        // because the conflict record must survive the exception — rolling it
        // back with the failed send would erase the only evidence that two tills
        // raced on the same table.
        if ($expectedSnapshotVersion !== null) {
            $current = (int) ($this->snapshot($order)['server_version'] ?? 0);

            if ($expectedSnapshotVersion < $current) {
                $this->recordConflict($config, $order, [
                    'client_version' => $expectedSnapshotVersion,
                    'server_version' => $current,
                ]);

                throw new DomainException('order_outdated');
            }
        }

        return $this->connection->transaction(function () use ($order, $config, $courseIndex, $deviceId, $expectedSnapshotVersion): array {
            $snapshot = $this->snapshot($order, lock: true);
            $version = (int) ($snapshot['server_version'] ?? 0);

            // Re-checked under the row lock: between the pre-flight check and
            // here, another device may have won the race.
            if ($expectedSnapshotVersion !== null && $expectedSnapshotVersion < $version) {
                throw new DomainException('order_outdated');
            }

            $delta = $this->delta($order, $courseIndex);

            if ($delta->isEmpty()) {
                return ['delta' => $delta, 'prep_orders' => [], 'print_jobs' => [], 'snapshot_version' => $version];
            }

            $prepOrders = $this->fanOutToDisplays($order, $config, $delta);
            $printJobs = $this->fanOutToPrinters($order, $config, $delta, $deviceId);

            // Scope the snapshot to the fired course so the other courses stay fireable (BAN-408).
            $this->writeSnapshot($order, $version + 1, $courseIndex);

            $order->forceFill([
                'prep_state' => OrderPrepState::Sent->value,
                'unsent_change_count' => 0,
                'last_prep_sent_at' => now(),
            ])->save();

            return [
                'delta' => $delta,
                'prep_orders' => $prepOrders,
                'print_jobs' => $printJobs,
                'snapshot_version' => $version + 1,
            ];
        });
    }

    /**
     * Withdraw everything already sent for this order (REG-295, BAN-465).
     *
     * Cancelling or deleting an order used to touch nothing but `pos_orders`: the prep order kept
     * its pending lines, the display kept showing the ticket, and the kitchen kept cooking food for
     * a sale that no longer existed. Nobody downstream was ever told.
     *
     * The delta cannot express this on its own — it compares the snapshot against the order's lines,
     * and cancelling an order does not remove its lines, so the diff comes back empty. So the
     * cancellation is built explicitly from the snapshot: every quantity the kitchen was told about,
     * negated. It then goes through the same fan-out as any other change, which is what makes the
     * cancellation tickets print and the displays update rather than needing a parallel path.
     *
     * @return array{delta: PreparationDelta, prep_orders: list<array<string, mixed>>, print_jobs: list<int>, snapshot_version: int}
     */
    public function cancelAll(Order $order, PosConfig $config, ?int $deviceId = null): array
    {
        return $this->connection->transaction(function () use ($order, $config, $deviceId): array {
            $snapshot = $this->snapshot($order, lock: true);
            $version = (int) ($snapshot['server_version'] ?? 0);

            /** @var array<string, array<string, mixed>> $sent */
            $sent = (array) ($snapshot['lines'] ?? []);

            $changes = [];

            foreach ($sent as $before) {
                $quantity = (string) ($before['quantity'] ?? '0');

                if (bccomp($quantity, '0', 3) === 0) {
                    continue;
                }

                $changes[] = $this->change($before, '-'.ltrim($quantity, '-'), PrepChangeType::Cancelled);
            }

            $delta = new PreparationDelta(
                orderUuid: (string) $order->uuid,
                changes: $changes,
                orderNoteChanged: false,
                generalCustomerNote: $order->general_customer_note,
                internalNote: is_string($order->internal_note) ? $order->internal_note : null,
                snapshotVersion: $version,
                snapshotAt: $snapshot['server_date'] ?? null,
            );

            if ($delta->isEmpty()) {
                // Never sent to the kitchen, so there is nothing to withdraw. Not an error — most
                // deleted drafts are abandoned before anyone fires them.
                return ['delta' => $delta, 'prep_orders' => [], 'print_jobs' => [], 'snapshot_version' => $version];
            }

            $prepOrders = $this->fanOutToDisplays($order, $config, $delta);
            $printJobs = $this->fanOutToPrinters($order, $config, $delta, $deviceId);

            // An empty snapshot: nothing stands sent any more. Without this a re-send of the same
            // order would diff against the old snapshot and re-cancel what it just cancelled.
            $this->writeEmptySnapshot($order, $version + 1);

            $order->forceFill([
                'prep_state' => OrderPrepState::Sent->value,
                'unsent_change_count' => 0,
            ])->save();

            return [
                'delta' => $delta,
                'prep_orders' => $prepOrders,
                'print_jobs' => $printJobs,
                'snapshot_version' => $version + 1,
            ];
        });
    }

    /**
     * Fire one course (RST-084). The fire ticket is a *note-update*-shaped
     * change listing the course's products, not a NEW ticket — otherwise the
     * kitchen counts those quantities twice.
     *
     * @return array{delta: PreparationDelta, prep_orders: list<array<string, mixed>>, print_jobs: list<int>, snapshot_version: int}
     */
    public function fireCourse(Order $order, PosConfig $config, OrderCourse $course, ?int $deviceId = null): array
    {
        $course->forceFill(['fired' => true, 'fired_at' => now()])->save();

        return $this->send($order, $config, (int) $course->course_index, $deviceId);
    }

    /**
     * Rebuild the snapshot to "everything already sent" without printing
     * (KDS-062). Used after a self-order submission so the cashier does not
     * re-fire lines the customer already ordered.
     */
    public function markAllSent(Order $order): int
    {
        $snapshot = $this->snapshot($order);
        $version = (int) ($snapshot['server_version'] ?? 0) + 1;

        $this->writeSnapshot($order, $version);

        $order->forceFill(['unsent_change_count' => 0, 'last_prep_sent_at' => now()])->save();

        return $version;
    }

    /**
     * Mark one course sent without printing — the offline-fire counterpart to the course-scoped
     * online send (RST-084 / BAN-408). Only that course's lines are recorded, so the others stay
     * fireable; without this, an offline `prep.sent` would snapshot every line and block the later
     * courses at the kitchen. `unsent_change_count` is recomputed from what is left order-wide.
     */
    public function markCourseSent(Order $order, int $courseIndex): int
    {
        $snapshot = $this->snapshot($order);
        $version = (int) ($snapshot['server_version'] ?? 0);

        // Idempotent on retry: if this course already has nothing unsent, don't re-snapshot or bump
        // the version. Unlike a whole-order send, an intermediate course fire leaves other courses
        // unsent, so the caller's `unsent_change_count === 0` guard cannot catch a replay here.
        if ($this->delta($order, $courseIndex)->isEmpty()) {
            return $version;
        }

        $version += 1;
        $this->writeSnapshot($order, $version, $courseIndex);

        $order->forceFill([
            'unsent_change_count' => $this->delta($order)->absoluteCount(),
            'last_prep_sent_at' => now(),
        ])->save();

        return $version;
    }

    /** The stored snapshot, for merge bookkeeping. @return array<string, mixed>|null */
    public function snapshotPayload(Order $order): ?array
    {
        $row = $this->connection->table('order_preparation_snapshots')->where('pos_order_id', $order->getKey())->first();

        return $row === null ? null : (array) $row;
    }

    /** @param array<string, mixed> $payload */
    public function restoreSnapshot(Order $order, array $payload): void
    {
        $this->connection->table('order_preparation_snapshots')->updateOrInsert(
            ['pos_order_id' => $order->getKey()],
            [
                'snapshot' => (string) ($payload['snapshot'] ?? '{}'),
                'general_customer_note' => $payload['general_customer_note'] ?? null,
                'internal_note' => $payload['internal_note'] ?? null,
                'server_version' => (int) ($payload['server_version'] ?? 0),
                'server_date' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        );
    }

    /**
     * Merge the source order's sent-quantities into the target's snapshot so a
     * transfer/merge produces no spurious kitchen tickets (RST-056).
     */
    public function mergeSnapshots(Order $source, Order $target): void
    {
        $sourceSnap = $this->snapshot($source);
        $targetSnap = $this->snapshot($target);

        /** @var array<string, array<string, mixed>> $lines */
        $lines = (array) ($targetSnap['lines'] ?? []);

        foreach ((array) ($sourceSnap['lines'] ?? []) as $uuid => $line) {
            if (isset($lines[$uuid])) {
                $lines[$uuid]['quantity'] = bcadd((string) $lines[$uuid]['quantity'], (string) $line['quantity'], 3);

                continue;
            }

            $lines[$uuid] = $line;
        }

        $this->connection->table('order_preparation_snapshots')->updateOrInsert(
            ['pos_order_id' => $target->getKey()],
            [
                'snapshot' => json_encode(['lines' => $lines]),
                'general_customer_note' => $target->general_customer_note,
                'internal_note' => is_string($target->internal_note) ? $target->internal_note : null,
                'server_version' => max((int) ($targetSnap['server_version'] ?? 0), (int) ($sourceSnap['server_version'] ?? 0)) + 1,
                'server_date' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        );

        $this->connection->table('order_preparation_snapshots')->where('pos_order_id', $source->getKey())->delete();

        // Existing kitchen tickets follow the lines to the surviving order.
        $this->connection->table('prep_orders')
            ->where('pos_order_id', $source->getKey())
            ->whereNotIn('prep_display_id', function ($q) use ($target): void {
                $q->from('prep_orders')->select('prep_display_id')->where('pos_order_id', $target->getKey());
            })
            ->update(['pos_order_id' => $target->getKey(), 'updated_at' => now()]);

        $this->connection->table('prep_orders')->where('pos_order_id', $source->getKey())->delete();
    }

    // ------------------------------------------------------------- internals

    /**
     * @return array{lines: array<string, array<string, mixed>>, server_version: int, server_date: ?string, general_customer_note: ?string, internal_note: ?string}
     */
    private function snapshot(Order $order, bool $lock = false): array
    {
        $query = $this->connection->table('order_preparation_snapshots')->where('pos_order_id', $order->getKey());

        if ($lock) {
            $query->lockForUpdate();
        }

        $row = $query->first();

        if ($row === null) {
            return ['lines' => [], 'server_version' => 0, 'server_date' => null, 'general_customer_note' => null, 'internal_note' => null];
        }

        /** @var array{lines?: array<string, array<string, mixed>>} $decoded */
        $decoded = json_decode((string) $row->snapshot, true) ?: [];

        return [
            'lines' => $decoded['lines'] ?? [],
            'server_version' => (int) $row->server_version,
            'server_date' => (string) $row->server_date,
            'general_customer_note' => $row->general_customer_note,
            'internal_note' => $row->internal_note,
        ];
    }

    /** @return array<string, array<string, mixed>> uuid => line state */
    private function currentState(Order $order): array
    {
        $rows = $this->connection->table('pos_order_lines')
            ->leftJoin('restaurant_order_courses', 'restaurant_order_courses.id', '=', 'pos_order_lines.restaurant_course_id')
            ->where('pos_order_lines.pos_order_id', $order->getKey())
            ->whereNull('pos_order_lines.deleted_at')
            ->where('pos_order_lines.skip_preparation', false)
            ->orderBy('pos_order_lines.id')
            ->select([
                'pos_order_lines.uuid',
                'pos_order_lines.id',
                'pos_order_lines.product_id',
                'pos_order_lines.pos_category_id',
                'pos_order_lines.full_product_name',
                'pos_order_lines.quantity',
                'pos_order_lines.customer_note',
                'pos_order_lines.internal_note',
                'pos_order_lines.combo_parent_line_id',
                'pos_order_lines.restaurant_course_id',
                'restaurant_order_courses.course_index',
                'restaurant_order_courses.uuid as course_uuid',
            ])
            ->get();

        $out = [];

        foreach ($rows as $row) {
            $out[(string) $row->uuid] = [
                'uuid' => (string) $row->uuid,
                'line_id' => (int) $row->id,
                'product_id' => (int) $row->product_id,
                'pos_category_id' => $row->pos_category_id === null ? null : (int) $row->pos_category_id,
                'name' => (string) $row->full_product_name,
                'quantity' => (string) $row->quantity,
                'customer_note' => $row->customer_note,
                'note' => $this->noteText($row->internal_note),
                'combo_parent_line_id' => $row->combo_parent_line_id === null ? null : (int) $row->combo_parent_line_id,
                'course_id' => $row->restaurant_course_id === null ? null : (int) $row->restaurant_course_id,
                'course_index' => (int) ($row->course_index ?? 1),
                'course_uuid' => $row->course_uuid,
            ];
        }

        $this->inheritComboRouting($order, $out);

        // The kitchen ticket is rebuilt from the structured options, not `full_product_name` alone
        // (KDS-006): the chosen no-variant attribute values and any custom text ("Happy Birthday")
        // are appended so the line reads "Cake (Chocolate, Happy Birthday)". The composed name is
        // what writeSnapshot stores, so this stays diff-stable across sends.
        //
        // The options ride onto the *initial* fire (a `New` change carries this name). Note the
        // delta keys on quantity and note only, so changing an option on an already-sent line does
        // not re-fire — Odoo cancels-and-readds there; we do not. Options are picked in the variant
        // dialog before the line is sent, so this edge only bites a post-send re-pick.
        $labels = $this->optionLabels(array_map(static fn (array $l): int => (int) $l['line_id'], $out));

        foreach ($out as &$line) {
            $extra = $labels[$line['line_id']] ?? [];
            if ($extra !== []) {
                $line['name'] = $line['name'].' ('.implode(', ', $extra).')';
            }
        }
        unset($line);

        return $out;
    }

    /**
     * KDS-004 — a combo child inherits its parent's station.
     *
     * A combo child usually has no `pos_category_id` of its own: the category lives on the combo
     * product the cashier tapped, not on the "Coke" inside it. Category routing then matched no
     * station, `forCategories()` filtered the child out of every display and printer, and the item
     * was simply never cooked — silently, because nothing errors when a line routes nowhere.
     *
     * Walks up rather than reading one level, since a combo can contain a combo. The depth guard is
     * for a cycle that only bad data could produce; without it this is an infinite loop inside the
     * send path.
     *
     * The ancestry is read from **all** the order's lines, not just the preparable ones. A parent
     * flagged `skip_preparation` (or soft-deleted after the child was added) is absent from
     * `$lines`, and resolving against that set alone would leave its children with no ancestor to
     * inherit from — uncooked again, for a different reason.
     *
     * Safe to mutate while iterating: the climb reads `$lines[...]` live, so a parent already
     * processed contributes its inherited category, and one not yet processed is simply climbed
     * past. Either order reaches the same nearest ancestor that owns a category.
     *
     * @param  array<string, array<string, mixed>>  $lines  keyed by uuid, mutated in place
     */
    private function inheritComboRouting(Order $order, array &$lines): void
    {
        $hasCombo = false;

        foreach ($lines as $line) {
            if (($line['combo_parent_line_id'] ?? null) !== null) {
                $hasCombo = true;
                break;
            }
        }

        if (! $hasCombo) {
            return;
        }

        $ancestry = $this->comboAncestry($order);
        $byLineId = [];

        foreach ($lines as $uuid => $line) {
            $byLineId[(int) $line['line_id']] = $uuid;
        }

        foreach ($lines as $uuid => $line) {
            $parentId = $line['combo_parent_line_id'] ?? null;

            if ($parentId === null) {
                continue;
            }

            $lines[$uuid]['combo_parent_uuid'] = $byLineId[(int) $parentId] ?? null;

            if ($line['pos_category_id'] !== null) {
                continue;
            }

            // Climb to the nearest ancestor that has a category of its own. Prefer the live value
            // from `$lines` (it may already carry an inherited category) and fall back to the raw
            // ancestry row for a parent this delta does not include.
            $cursor = (int) $parentId;

            for ($depth = 0; $depth < self::MAX_COMBO_DEPTH; $depth++) {
                $parentUuid = $byLineId[$cursor] ?? null;
                $parent = $parentUuid !== null ? $lines[$parentUuid] : ($ancestry[$cursor] ?? null);

                if ($parent === null) {
                    break;
                }

                if (($parent['pos_category_id'] ?? null) !== null) {
                    $lines[$uuid]['pos_category_id'] = (int) $parent['pos_category_id'];
                    break;
                }

                if (($parent['combo_parent_line_id'] ?? null) === null) {
                    break;
                }

                $cursor = (int) $parent['combo_parent_line_id'];
            }
        }
    }

    /**
     * Every line of the order as `id => [pos_category_id, combo_parent_line_id]`, unfiltered.
     *
     * Deliberately ignores `skip_preparation` and `deleted_at`: a line that is not itself cooked can
     * still be the only thing standing between its children and a station.
     *
     * @return array<int, array{pos_category_id: ?int, combo_parent_line_id: ?int}>
     */
    private function comboAncestry(Order $order): array
    {
        $out = [];

        foreach ($this->connection->table('pos_order_lines')
            ->where('pos_order_id', $order->getKey())
            ->get(['id', 'pos_category_id', 'combo_parent_line_id']) as $row) {
            $out[(int) $row->id] = [
                'pos_category_id' => $row->pos_category_id === null ? null : (int) $row->pos_category_id,
                'combo_parent_line_id' => $row->combo_parent_line_id === null ? null : (int) $row->combo_parent_line_id,
            ];
        }

        return $out;
    }

    /**
     * Per-line option labels for the ticket: the selected attribute values by name, then any custom
     * values, in a stable order.
     *
     * @param  list<int>  $lineIds
     * @return array<int, list<string>>
     */
    private function optionLabels(array $lineIds): array
    {
        if ($lineIds === []) {
            return [];
        }

        $labels = [];

        foreach ($this->connection->table('pos_order_line_attribute_value as olav')
            ->join('product_attribute_line_values as palv', 'palv.id', '=', 'olav.product_attribute_line_value_id')
            ->join('product_attribute_values as pav', 'pav.id', '=', 'palv.product_attribute_value_id')
            ->whereIn('olav.pos_order_line_id', $lineIds)
            ->orderBy('olav.product_attribute_line_value_id')
            ->get(['olav.pos_order_line_id as line_id', 'pav.name']) as $row) {
            $labels[(int) $row->line_id][] = (string) $row->name;
        }

        foreach ($this->connection->table('pos_order_line_custom_attribute_values')
            ->whereIn('pos_order_line_id', $lineIds)
            ->orderBy('id')
            ->get(['pos_order_line_id as line_id', 'custom_value']) as $row) {
            $labels[(int) $row->line_id][] = (string) $row->custom_value;
        }

        return $labels;
    }

    /** @param array<string, mixed> $line */
    private function change(array $line, string $quantity, PrepChangeType $type): PreparationChange
    {
        return new PreparationChange(
            lineUuid: (string) $line['uuid'],
            lineId: isset($line['line_id']) ? (int) $line['line_id'] : null,
            productId: (int) ($line['product_id'] ?? 0),
            posCategoryId: isset($line['pos_category_id']) ? (int) $line['pos_category_id'] : null,
            name: (string) ($line['name'] ?? ''),
            quantity: $quantity,
            changeType: $type,
            customerNote: isset($line['customer_note']) ? (string) $line['customer_note'] : null,
            internalNote: isset($line['note']) ? (string) $line['note'] : null,
            courseId: isset($line['course_id']) ? (int) $line['course_id'] : null,
            courseIndex: (int) ($line['course_index'] ?? 1),
            // Resolved by inheritComboRouting (KDS-004); the board groups a combo's children under
            // their parent, which it cannot do if every line claims to be a root.
            comboParentUuid: isset($line['combo_parent_uuid']) ? (string) $line['combo_parent_uuid'] : null,
        );
    }

    /**
     * Category-based routing to displays (KDS-004). A display with
     * `show_all_categories` takes everything; combo children with no category
     * of their own inherit the parent's.
     *
     * @return list<array<string, mixed>>
     */
    private function fanOutToDisplays(Order $order, PosConfig $config, PreparationDelta $delta): array
    {
        $displays = $this->connection->table('prep_displays')
            ->join('pos_config_prep_display', 'pos_config_prep_display.prep_display_id', '=', 'prep_displays.id')
            ->where('pos_config_prep_display.pos_config_id', $config->getKey())
            ->where('prep_displays.active', true)
            ->select('prep_displays.*')
            ->get();

        $out = [];

        foreach ($displays as $display) {
            $categoryIds = $this->connection->table('pos_category_prep_display')
                ->where('prep_display_id', $display->id)
                ->pluck('pos_category_id')
                ->map(static fn (mixed $v): int => (int) $v)
                ->all();

            $routed = $delta->forCategories($categoryIds, (bool) $display->show_all_categories);

            // KDS-053, display half. BAN-454 taught the printers that an order note is not a line —
            // it routes to no category, so `$routed` is empty for every station and bailing here
            // threw the change away. The screens never got the same lesson: a kitchen running on
            // displays alone, with no preparation printers, never learned that "ALLERGY: no onions"
            // was added after the send. The food went out with the onions.
            //
            // Same rule as the printer path, deliberately rather than by accident: the note goes to
            // the displays already showing this order, because those are the cooks who can still act
            // on it. A display that never received the order has nothing to amend, and giving it a
            // card now would put a lineless ticket on a screen that was never cooking the dish.
            $noteOnly = $routed === [] && $delta->orderNoteChanged && $this->hasCard($order, (int) $display->id);

            if ($routed === [] && ! $noteOnly) {
                continue;
            }

            // Passed the empty `$routed` unchanged. `upsertPrepOrder` then takes its update branch —
            // guaranteed to exist, since `hasCard` is what got us here — refreshes `order_note`,
            // writes no lines, and broadcasts. The card the cook is looking at already carries the
            // note; the ticket event is the nudge that makes the open board re-read it.
            $out[] = $this->upsertPrepOrder($order, $config, $display, $routed);
        }

        return $out;
    }

    /**
     * @param  list<PreparationChange>  $changes
     * @return array<string, mixed>
     */
    private function upsertPrepOrder(Order $order, PosConfig $config, object $display, array $changes): array
    {
        $existing = $this->connection->table('prep_orders')
            ->where('prep_display_id', $display->id)
            ->where('pos_order_id', $order->getKey())
            ->first();

        $now = Carbon::now();

        if ($existing === null) {
            $prepOrderId = (int) $this->connection->table('prep_orders')->insertGetId([
                'uuid' => (string) Str::uuid(),
                'prep_display_id' => $display->id,
                'pos_order_id' => $order->getKey(),
                'pos_config_id' => $config->getKey(),
                'tracking_number' => $order->tracking_number,
                'table_label' => $this->tableLabel($order),
                'guest_count' => (int) $order->guest_count,
                'preset_label' => null,
                'customer_name' => null,
                'order_note' => $order->general_customer_note,
                'state' => PrepOrderState::Pending->value,
                'fired_at' => $now,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $prepUuid = (string) $this->connection->table('prep_orders')->where('id', $prepOrderId)->value('uuid');
        } else {
            $prepOrderId = (int) $existing->id;
            $prepUuid = (string) $existing->uuid;
            $this->connection->table('prep_orders')->where('id', $prepOrderId)->update([
                'guest_count' => (int) $order->guest_count,
                'table_label' => $this->tableLabel($order),
                'order_note' => $order->general_customer_note,
                'updated_at' => $now,
            ]);
        }

        $defaultStage = $this->connection->table('prep_stages')
            ->where('prep_display_id', $display->id)
            ->where('stage_type', PrepStageType::Todo->value)
            ->orderBy('sequence')
            ->value('id');

        $lines = [];

        foreach ($changes as $change) {
            $lineId = (int) $this->connection->table('prep_order_lines')->insertGetId([
                'uuid' => (string) Str::uuid(),
                'prep_order_id' => $prepOrderId,
                'pos_order_line_id' => $change->lineId,
                'pos_order_line_uuid' => $change->lineUuid,
                'prep_stage_id' => $defaultStage,
                'restaurant_course_id' => $change->courseId,
                'course_index' => $change->courseIndex,
                'product_id' => $change->productId,
                'pos_category_id' => $change->posCategoryId,
                'display_name' => $change->name,
                'quantity' => $change->quantity,
                'change_type' => $change->changeType->value,
                'customer_note' => $change->customerNote,
                'internal_note' => $change->internalNote,
                'combo_parent_uuid' => $change->comboParentUuid,
                'state' => PrepLineState::Todo->value,
                'fired_at' => $now,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $lines[] = ['id' => $lineId, ...$change->toArray()];
        }

        $ticket = [
            'prep_order_id' => $prepOrderId,
            'prep_order_uuid' => $prepUuid,
            'prep_display_id' => (int) $display->id,
            'order_uuid' => (string) $order->uuid,
            'tracking_number' => $order->tracking_number,
            'table_label' => $this->tableLabel($order),
            'guest_count' => (int) $order->guest_count,
            'fired_at' => $now->toIso8601ZuluString('millisecond'),
            'lines' => $lines,
        ];

        $this->events->dispatch(new KitchenTicketCreated(
            displayToken: (string) $display->access_token,
            configToken: (string) $config->access_token,
            ticket: $ticket,
        ));

        return $ticket;
    }

    /**
     * One ticket per change type per printer (KDS-053): NEW, CANCELLED,
     * NOTE-UPDATE and the order-note ticket, up to four per printer per send.
     *
     * @return list<int>
     */
    private function fanOutToPrinters(Order $order, PosConfig $config, PreparationDelta $delta, ?int $deviceId): array
    {
        if (! $config->use_preparation_printers) {
            return [];
        }

        $printers = $this->connection->table('pos_printers')
            ->join('pos_config_printer', 'pos_config_printer.pos_printer_id', '=', 'pos_printers.id')
            ->where('pos_config_printer.pos_config_id', $config->getKey())
            ->where('pos_printers.active', true)
            ->select('pos_printers.*')
            ->get();

        $jobs = [];

        foreach ($printers as $printer) {
            $categoryIds = $this->connection->table('pos_category_pos_printer')
                ->where('pos_printer_id', $printer->id)
                ->pluck('pos_category_id')
                ->map(static fn (mixed $v): int => (int) $v)
                ->all();

            $routed = $delta->forCategories($categoryIds, (bool) $printer->print_all_categories);

            // KDS-053 — an order note is not a line, so it routes to no category and `$routed` is
            // empty for every printer. Bailing here meant that adding "no onions" after the send
            // produced zero print jobs and the kitchen never learned about it, even though
            // `PreparationDelta::isEmpty()` correctly calls that delta non-empty.
            //
            // The note goes to the stations already cooking this order — they are the ones who can
            // still act on it. A printer that has never seen the order has nothing to amend.
            $noteOnly = $routed === [] && $delta->orderNoteChanged && $this->hasPrinted($order, (int) $printer->id);

            if ($routed === [] && ! $noteOnly) {
                continue;
            }

            foreach ([PrepChangeType::New, PrepChangeType::Cancelled, PrepChangeType::NoteUpdate] as $type) {
                $subset = array_values(array_filter($routed, static fn (PreparationChange $c): bool => $c->changeType === $type));

                // The order-note ticket carries no lines: the note itself is the whole message, and
                // the renderer already puts it in the payload's `notes`.
                if ($subset === [] && ! ($noteOnly && $type === PrepChangeType::NoteUpdate)) {
                    continue;
                }

                $payload = $this->renderer->payload($order, $config, $printer, $subset, $type);

                $jobs[] = (int) $this->connection->table('preparation_print_jobs')->insertGetId([
                    'uuid' => (string) Str::uuid(),
                    'company_id' => $config->company_id,
                    'pos_config_id' => $config->getKey(),
                    'pos_printer_id' => $printer->id,
                    'pos_order_id' => $order->getKey(),
                    'pos_device_id' => $deviceId,
                    'job_type' => $this->jobTypeFor($type)->value,
                    'payload' => json_encode($payload),
                    'rendered_text' => null,
                    'copies' => (int) $printer->copies,
                    'state' => PrintJobState::Queued->value,
                    'queued_at' => now(),
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        }

        return $jobs;
    }

    /**
     * Is this display already showing this order? (KDS-053)
     *
     * The display counterpart of {@see hasPrinted()}. A `prep_orders` row is the screen's equivalent
     * of a printed ticket: it is the evidence that this station was told to cook something.
     */
    private function hasCard(Order $order, int $displayId): bool
    {
        return $this->connection->table('prep_orders')
            ->where('prep_display_id', $displayId)
            ->where('pos_order_id', $order->getKey())
            ->exists();
    }

    /** Has this printer already been sent anything for this order? (KDS-053) */
    private function hasPrinted(Order $order, int $printerId): bool
    {
        return $this->connection->table('preparation_print_jobs')
            ->where('pos_order_id', $order->getKey())
            ->where('pos_printer_id', $printerId)
            ->exists();
    }

    private function jobTypeFor(PrepChangeType $type): PrintJobType
    {
        return match ($type) {
            PrepChangeType::New => PrintJobType::PrepNew,
            PrepChangeType::Cancelled => PrintJobType::PrepCancelled,
            PrepChangeType::NoteUpdate => PrintJobType::PrepNoteUpdate,
            PrepChangeType::FireCourse => PrintJobType::PrepFireCourse,
        };
    }

    /**
     * Advance the "what the kitchen has been told" snapshot.
     *
     * With `$courseIndex`, only that course's lines are recorded as sent — the other courses keep
     * whatever the kitchen already knew. Snapshotting *every* line on a single-course fire was the
     * BAN-408 bug: firing course 1 marked courses 2 and 3 sent, so their delta was empty forever and
     * they could never be fired.
     */
    private function writeSnapshot(Order $order, int $version, ?int $courseIndex = null): void
    {
        $lines = [];

        // Course fire: start from the existing snapshot, minus this course (its lines are rebuilt
        // below from the current state, so an added/changed/removed line in the fired course is
        // reflected while the untouched courses are preserved).
        if ($courseIndex !== null) {
            foreach ((array) ($this->snapshot($order)['lines'] ?? []) as $uuid => $line) {
                if ((int) ($line['course_index'] ?? 1) !== $courseIndex) {
                    $lines[$uuid] = $line;
                }
            }
        }

        foreach ($this->currentState($order) as $uuid => $line) {
            if ($courseIndex !== null && (int) $line['course_index'] !== $courseIndex) {
                continue;
            }

            $lines[$uuid] = [
                'uuid' => $uuid,
                'quantity' => (string) $line['quantity'],
                'name' => $line['name'],
                'product_id' => $line['product_id'],
                // Already resolved by inheritComboRouting, and it has to be: when the line is later
                // deleted, its cancellation is built from *this* row, and a cancellation that
                // routes nowhere is the same bug as a combo child that routes nowhere (KDS-004).
                'pos_category_id' => $line['pos_category_id'],
                'combo_parent_uuid' => $line['combo_parent_uuid'] ?? null,
                'note' => $line['note'],
                'customer_note' => $line['customer_note'],
                'course_index' => $line['course_index'],
            ];
        }

        $this->connection->table('order_preparation_snapshots')->updateOrInsert(
            ['pos_order_id' => $order->getKey()],
            [
                'snapshot' => json_encode(['lines' => $lines]),
                'general_customer_note' => $order->general_customer_note,
                'internal_note' => is_string($order->internal_note) ? $order->internal_note : null,
                'server_version' => $version,
                'server_date' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        );
    }

    /**
     * Record that nothing stands sent to the kitchen for this order any more.
     *
     * Written from the same shape `writeSnapshot` produces, minus the lines — `cancelAll` cannot
     * reuse that method because it rebuilds the snapshot from the order's *current* lines, which a
     * cancelled order still has.
     */
    private function writeEmptySnapshot(Order $order, int $version): void
    {
        $this->connection->table('order_preparation_snapshots')->updateOrInsert(
            ['pos_order_id' => $order->getKey()],
            [
                'snapshot' => json_encode(['lines' => []]),
                'general_customer_note' => $order->general_customer_note,
                'internal_note' => is_string($order->internal_note) ? $order->internal_note : null,
                'server_version' => $version,
                'server_date' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        );
    }

    /** @param array<string, mixed> $detail */
    private function recordConflict(PosConfig $config, Order $order, array $detail): void
    {
        $this->connection->table('sync_conflicts')->insert([
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => $config->getKey(),
            'conflict_type' => SyncConflictType::PrepSnapshotStale->value,
            'model_type' => Order::class,
            'record_uuid' => (string) $order->uuid,
            'resolution' => SyncResolution::ServerWins->value,
            'detail' => json_encode($detail),
            'detected_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    private function tableLabel(Order $order): ?string
    {
        if ($order->restaurant_table_id === null) {
            return $order->floating_order_name;
        }

        $row = $this->connection->table('restaurant_tables')->where('id', $order->restaurant_table_id)->first(['name', 'table_number']);

        if ($row === null) {
            return null;
        }

        return (string) ($row->name ?? ('T '.$row->table_number));
    }

    private function noteText(mixed $note): ?string
    {
        if ($note === null) {
            return null;
        }

        if (is_string($note) && str_starts_with(trim($note), '[')) {
            /** @var list<array{text?: string}> $decoded */
            $decoded = json_decode($note, true) ?: [];

            return implode(' · ', array_map(static fn (array $n): string => (string) ($n['text'] ?? ''), $decoded)) ?: null;
        }

        return is_string($note) ? $note : null;
    }

    /** Convenience for the "unsent changes" badge on the register. */
    public function unsentChangeCount(Order $order): int
    {
        return $this->delta($order)->absoluteCount();
    }

    /** Convenience wrapper used by OrderLine bookkeeping. @return list<OrderLine> */
    public function linesOf(Order $order): array
    {
        /** @var list<OrderLine> $lines */
        $lines = OrderLine::query()->where('pos_order_id', $order->getKey())->get()->all();

        return $lines;
    }
}
