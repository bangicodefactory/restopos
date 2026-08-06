<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Illuminate\Database\ConnectionInterface;

/**
 * The refundable-quantity cap (BAN-406, REG-270 … REG-272).
 *
 * Until this existed a device could refund a ten-euro order ten times. `refunded_quantity` was
 * tracked in the browser and nowhere else, so two tills each refunding the same line in full were
 * both booked, and one till doing it twice was booked twice. Probed before writing any of this: a
 * line sold twice took four units of refunds, and the original's `refunded_quantity` stayed at zero
 * throughout.
 *
 * ## Three rules, and the third is the one that makes the other two mean anything
 *
 * 1. **A refund line must name the line it refunds.** `refunded_order_line_id` had never once been
 *    written — `createLine` resolved it through a helper that returns null unless it is handed an
 *    order, and it was called without one. So the cap has nothing to count against until the link
 *    is both written and *required*.
 * 2. **The sum of accepted refunds may not exceed what was sold**, counted under a row lock on the
 *    original line so two tills submitting at once cannot both read "nothing refunded yet".
 * 3. **Every negative line is a refund.** Keyed on the sign of the quantity, not on the client's
 *    `is_refund` flag, because a flag the client sets is a rule the client can decline to follow.
 *    Nothing else in the register produces a negative quantity.
 *
 * Cancelled refunds do not count against the cap: withdrawing a refund has to give the quantity
 * back, or a mistaken refund permanently reduces what the customer can be given.
 */
final readonly class RefundService
{
    public function __construct(private ConnectionInterface $connection) {}

    /** A line command that takes quantity away is a refund, whatever the order claims to be. */
    public function isRefundLine(mixed $quantity): bool
    {
        $value = (string) ($quantity ?? '0');

        return preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)$/', $value) === 1
            && bccomp($value, '0', 6) < 0;
    }

    /**
     * How much of this line has already been given back.
     *
     * Locked, because the read and the insert that follows it are the whole race: two tills each
     * refunding the last unit both read "one remaining" and both are booked. The lock is taken on
     * the *original* line — the row both refunds contend for — not on either refund order.
     *
     * `$excludingLineId` lets an edit be measured as a replacement rather than an addition, so
     * correcting a refund from 2 to 3 is scored as 3 and not as 5.
     */
    public function alreadyRefunded(int $originalLineId, ?int $excludingLineId = null, bool $lock = true): string
    {
        // The lock belongs to the decision, not to every read. `refreshRefundedQuantity` and the
        // post-write check run *after* the preflight has already taken it in this transaction, so
        // re-taking it there buys nothing and costs a query per line.
        if ($lock) {
            OrderLine::query()->whereKey($originalLineId)->lockForUpdate()->first();
        }

        $rows = $this->connection->table('pos_order_lines')
            ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
            ->where('pos_order_lines.refunded_order_line_id', $originalLineId)
            // A withdrawn refund gives the quantity back; otherwise one mistake permanently
            // reduces what the customer can still be given. Three ways a refund is withdrawn, and
            // all three have to be honoured here:
            //
            //   - the order is cancelled
            //   - the order is deleted (drafts soft-delete)
            //   - the *line* is removed from the order — and `pos_order_lines` soft-deletes too,
            //     which this missed at first. These are raw builder queries, so no Eloquent scope
            //     is applied for us: a line the cashier took off a draft went on consuming its
            //     quantity forever, and the customer could never be given it back.
            ->where('pos_orders.state', '!=', OrderState::Cancelled->value)
            ->whereNull('pos_orders.deleted_at')
            ->whereNull('pos_order_lines.deleted_at')
            ->when($excludingLineId !== null, fn ($q) => $q->where('pos_order_lines.id', '!=', $excludingLineId))
            ->pluck('pos_order_lines.quantity');

        $total = '0';

        foreach ($rows as $quantity) {
            // Refund lines are stored negative; the running total is the positive magnitude.
            $total = bcadd($total, bcmul((string) $quantity, '-1', 6), 6);
        }

        return $total;
    }

    /**
     * Re-derive the original line's `refunded_quantity` from the refunds that exist.
     *
     * Derived rather than incremented. An increment is a second copy of the truth that drifts the
     * first time a refund is cancelled or a batch is replayed, and this column is what the till
     * shows the cashier as "still refundable".
     */
    public function refreshRefundedQuantity(int $originalLineId): void
    {
        $original = OrderLine::query()->find($originalLineId);

        if ($original === null) {
            return;
        }

        $original->forceFill([
            'refunded_quantity' => $this->alreadyRefunded($originalLineId, lock: false),
        ])->save();
    }

    /**
     * Re-derive every original line credited by this order.
     *
     * Called when refunds *leave* — a line deleted from a draft refund, or the whole refund
     * cancelled. Both were missed at first, and the effect is nastier than it sounds: the cap
     * recomputes correctly from the rows that remain, so the customer *can* be refunded again, but
     * `refunded_quantity` is the column the ticket screen reads as "still refundable". Left stale it
     * shows 0 remaining, and the cashier cannot even attempt the refund the guard would allow.
     */
    public function refreshOriginalsCreditedBy(int $refundOrderId): void
    {
        $ids = OrderLine::query()
            ->withTrashed()
            ->where('pos_order_id', $refundOrderId)
            ->whereNotNull('refunded_order_line_id')
            ->distinct()
            ->pluck('refunded_order_line_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all();

        foreach ($ids as $id) {
            $this->refreshRefundedQuantity($id);
        }
    }

    /**
     * Everything the preflight needs about a whole push, in four queries rather than four per line.
     *
     * The per-line version cost ten queries a line — resolve the link, load the existing line, load
     * the original, take the lock, sum the prior refunds — which a "refund everything" on a long
     * restaurant tab turns into hundreds. Nothing about the rules changes here; the same facts are
     * fetched once for the whole batch and read out of memory.
     *
     * The lock still covers every original in one statement, so the serialisation the cap depends on
     * is unchanged: a competing transaction blocks on the first of these rows it needs.
     *
     * @param  array<int, array<string, mixed>>  $lineCommands
     * @return array{
     *     existing: array<string, OrderLine>,
     *     targets: array<string, int>,
     *     sold: array<int, string>,
     *     refunded: array<int, string>,
     *     ownContribution: array<int, string>,
     * }
     */
    public function preflightContext(Order $refund, array $lineCommands): array
    {
        $lineUuids = [];
        $targetUuids = [];

        foreach ($lineCommands as $command) {
            $command = (array) $command;

            if (! $this->isRefundLine($command['qty'] ?? $command['quantity'] ?? null)) {
                continue;
            }

            if (is_string($command['uuid'] ?? null) && $command['uuid'] !== '') {
                $lineUuids[] = (string) $command['uuid'];
            }

            if (is_string($command['refunded_line_uuid'] ?? null) && $command['refunded_line_uuid'] !== '') {
                $targetUuids[] = (string) $command['refunded_line_uuid'];
            }
        }

        if ($lineUuids === [] && $targetUuids === []) {
            return ['existing' => [], 'targets' => [], 'sold' => [], 'refunded' => [], 'ownContribution' => []];
        }

        /** @var array<string, OrderLine> $existing this refund's lines already on the server */
        $existing = OrderLine::query()
            ->where('pos_order_id', $refund->getKey())
            ->whereIn('uuid', $lineUuids === [] ? [''] : $lineUuids)
            ->get()
            ->keyBy('uuid')
            ->all();

        // Resolved *within* the original order, exactly as the per-line lookup did — a line uuid
        // from anywhere else resolves to nothing.
        $targets = $refund->refunded_order_id === null || $targetUuids === []
            ? []
            : OrderLine::query()
                ->where('pos_order_id', $refund->refunded_order_id)
                ->whereIn('uuid', $targetUuids)
                ->pluck('id', 'uuid')
                ->map(static fn (mixed $id): int => (int) $id)
                ->all();

        $originalIds = array_values(array_unique([
            ...array_values($targets),
            ...array_values(array_filter(array_map(
                static fn (OrderLine $line): ?int => $line->refunded_order_line_id === null
                    ? null
                    : (int) $line->refunded_order_line_id,
                $existing,
            ))),
        ]));

        if ($originalIds === []) {
            return ['existing' => $existing, 'targets' => $targets, 'sold' => [], 'refunded' => [], 'ownContribution' => []];
        }

        // One lock statement over every original this push touches. This is the serialisation the
        // whole cap rests on, and it is exactly as strong as the per-line version was.
        $sold = OrderLine::query()
            ->whereKey($originalIds)
            ->lockForUpdate()
            ->pluck('quantity', 'id')
            ->map(static fn (mixed $q): string => (string) $q)
            ->all();

        $refunded = $this->refundedTotals($originalIds);

        // What *this* order already contributes, so an edit is measured as a replacement rather
        // than as an addition on top of itself.
        $ownContribution = [];

        foreach ($existing as $line) {
            if ($line->refunded_order_line_id === null) {
                continue;
            }

            $key = (int) $line->refunded_order_line_id;
            $ownContribution[$key] = bcadd(
                $ownContribution[$key] ?? '0',
                bcmul((string) $line->quantity, '-1', 6),
                6,
            );
        }

        return [
            'existing' => $existing,
            'targets' => $targets,
            'sold' => $sold,
            'refunded' => $refunded,
            'ownContribution' => $ownContribution,
        ];
    }

    /**
     * Units already given back, per original line, honouring every way a refund is withdrawn.
     *
     * @param  list<int>  $originalLineIds
     * @return array<int, string>
     */
    public function refundedTotals(array $originalLineIds): array
    {
        if ($originalLineIds === []) {
            return [];
        }

        $rows = $this->connection->table('pos_order_lines')
            ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
            ->whereIn('pos_order_lines.refunded_order_line_id', $originalLineIds)
            ->where('pos_orders.state', '!=', OrderState::Cancelled->value)
            ->whereNull('pos_orders.deleted_at')
            ->whereNull('pos_order_lines.deleted_at')
            ->groupBy('pos_order_lines.refunded_order_line_id')
            ->selectRaw('pos_order_lines.refunded_order_line_id as original_id, SUM(pos_order_lines.quantity) as total')
            ->pluck('total', 'original_id');

        $totals = [];

        foreach ($rows as $originalId => $total) {
            $totals[(int) $originalId] = bcmul((string) $total, '-1', 6);
        }

        return $totals;
    }

    /**
     * Re-derive `refunded_quantity` on several originals at once.
     *
     * @param  list<int>  $originalLineIds
     */
    public function refreshMany(array $originalLineIds): void
    {
        $ids = array_values(array_unique($originalLineIds));

        if ($ids === []) {
            return;
        }

        $totals = $this->refundedTotals($ids);

        foreach ($ids as $id) {
            OrderLine::query()->whereKey($id)->update(['refunded_quantity' => $totals[$id] ?? '0']);
        }
    }

    /**
     * The first original line, if any, that has now been refunded past what it sold.
     *
     * Checked *after* the write. The lock in {@see alreadyRefunded()} serialises two transactions
     * contending for the same original line, which is the right mechanism and is what protects a
     * real deployment — but it only protects the paths that take it. This asks the question the
     * cap exists to answer, of the data as it finally stands, so the invariant holds however the
     * rows arrived. A forced race showed the difference: the preflight approved on a correct read
     * and a competing refund landed between that read and the insert.
     *
     * @param  list<int>  $originalLineIds
     */
    public function firstOverRefunded(array $originalLineIds): ?int
    {
        $ids = array_values(array_unique($originalLineIds));

        if ($ids === []) {
            return null;
        }

        // Two grouped queries for the whole push rather than two per line. A "refund everything" on
        // a long restaurant tab is the case that made this worth doing.
        $refunded = $this->refundedTotals($ids);
        $sold = OrderLine::query()->whereKey($ids)->pluck('quantity', 'id');

        foreach ($ids as $originalLineId) {
            if (! $sold->has($originalLineId)) {
                continue;
            }

            if (bccomp($refunded[$originalLineId] ?? '0', (string) $sold[$originalLineId], 6) > 0) {
                return $originalLineId;
            }
        }

        return null;
    }

    /**
     * The distinct original orders a set of refund line commands points at.
     *
     * Spec 01 §1807: a refund references exactly one original order. Enforced across the whole
     * batch rather than line by line, because the violation is only visible when the lines are
     * looked at together.
     *
     * @param  array<int, array<string, mixed>>  $commands
     * @return list<int>
     */
    public function originalOrderIds(array $commands): array
    {
        $uuids = [];

        foreach ($commands as $command) {
            $command = (array) $command;
            $uuid = $command['refunded_line_uuid'] ?? null;

            if (is_string($uuid) && $uuid !== '') {
                $uuids[] = $uuid;
            }
        }

        if ($uuids === []) {
            return [];
        }

        return OrderLine::query()
            ->whereIn('uuid', array_values(array_unique($uuids)))
            ->distinct()
            ->pluck('pos_order_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->values()
            ->all();
    }
}
