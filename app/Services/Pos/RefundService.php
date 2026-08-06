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
     * Resolve the line this refund points at — within the original order, and only there.
     *
     * Scoped through `refunded_order_id`, which `ingest` has already resolved and which the company
     * scope has already constrained. A lookup by bare uuid would let a device refund against any
     * line whose uuid it had merely observed, in any venue.
     *
     * @param  array<string, mixed>  $command
     */
    public function targetLineId(Order $refund, array $command): ?int
    {
        $uuid = $command['refunded_line_uuid'] ?? null;

        if (! is_string($uuid) || $uuid === '' || $refund->refunded_order_id === null) {
            return null;
        }

        $id = OrderLine::query()
            ->where('uuid', $uuid)
            ->where('pos_order_id', $refund->refunded_order_id)
            ->value('id');

        return $id === null ? null : (int) $id;
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
    public function alreadyRefunded(int $originalLineId, ?int $excludingLineId = null): string
    {
        OrderLine::query()->whereKey($originalLineId)->lockForUpdate()->first();

        $rows = $this->connection->table('pos_order_lines')
            ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
            ->where('pos_order_lines.refunded_order_line_id', $originalLineId)
            // A withdrawn refund gives the quantity back; otherwise one mistake permanently
            // reduces what the customer can still be given.
            ->where('pos_orders.state', '!=', OrderState::Cancelled->value)
            ->whereNull('pos_orders.deleted_at')
            ->when($excludingLineId !== null, fn ($q) => $q->where('pos_order_lines.id', '!=', $excludingLineId))
            ->pluck('pos_order_lines.quantity');

        $total = '0';

        foreach ($rows as $quantity) {
            // Refund lines are stored negative; the running total is the positive magnitude.
            $total = bcadd($total, bcmul((string) $quantity, '-1', 6), 6);
        }

        return $total;
    }

    /** What is left to give back on this line, never below zero. */
    public function remaining(OrderLine $original, string $alreadyRefunded): string
    {
        $remaining = bcsub((string) $original->quantity, $alreadyRefunded, 6);

        return bccomp($remaining, '0', 6) < 0 ? '0' : $remaining;
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
            'refunded_quantity' => $this->alreadyRefunded($originalLineId),
        ])->save();
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
        foreach (array_values(array_unique($originalLineIds)) as $originalLineId) {
            $original = OrderLine::query()->find($originalLineId);

            if ($original === null) {
                continue;
            }

            if (bccomp($this->alreadyRefunded($originalLineId), (string) $original->quantity, 6) > 0) {
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
