<?php

declare(strict_types=1);

namespace App\Services\Audit;

use App\Enums\OrderEditAction;
use App\Models\Audit\OrderEditLog;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use Illuminate\Support\Str;

/**
 * The one writer of `pos_order_edit_logs` (BAN-413, REG-123).
 *
 * The fine-grained half of the trail: not "this order was edited" but "this line went from 3 to 1
 * at 21:14, on till 2, by employee 7, and that took €18.60 off the ticket". `amount_impact` is the
 * column that matters — a manager's fraud report ranks by it, because the pattern being looked for
 * is a cashier who voids a line after the customer has walked away with the food.
 *
 * ## Gated, and the gate is real
 *
 * `pos_configs.order_edit_tracking` is off by default. Odoo has the same switch and the same
 * default, and the reason is that this table grows one row per edit per line — on a busy counter
 * that is a lot of rows to keep for a venue that does not want the feature. Every method here
 * returns early when the config has it off; `audit_logs` is deliberately *not* gated by it, so
 * turning edit tracking off still leaves drawer opens, cash moves and session closes recorded.
 *
 * ## Only actual changes are logged
 *
 * A register re-pushes a draft on every edit and again at payment, so the same line arrives many
 * times with the same values. Logging on receipt rather than on change would bury the two rows that
 * matter under two hundred that say nothing — and would do it worst on the busiest till, which is
 * the one you would be investigating. {@see AuditRecorder::diff()} does the comparison, numerically,
 * so `'2'` from the client and `'2.000'` from the column are one quantity and not an edit.
 */
final readonly class OrderEditRecorder
{
    /** Fields that produce their own log row, in the order they are checked. */
    private const Tracked = [
        'quantity' => OrderEditAction::QtyIncreased,   // direction resolved per row
        'price_unit' => OrderEditAction::PriceChanged,
        'discount_percent' => OrderEditAction::DiscountChanged,
        'customer_note' => OrderEditAction::NoteChanged,
    ];

    public function enabled(PosConfig $config): bool
    {
        return (bool) $config->order_edit_tracking;
    }

    /**
     * A line that was not on the ticket a moment ago.
     *
     * Logged as much as the removals are: a line added *after* the customer paid is the other shape
     * of the same fraud, and the pair only reads as a pair if both ends are recorded.
     */
    public function lineAdded(
        PosConfig $config,
        Order $order,
        OrderLine $line,
        ?int $employeeId = null,
        PosDevice|int|null $device = null,
    ): void {
        if (! $this->enabled($config)) {
            return;
        }

        $this->write($order, $line, $line->uuid, OrderEditAction::LineAdded, [
            'new_value' => $this->trim((string) $line->quantity),
            'amount_impact' => $this->extended($line),
        ], $employeeId, $device);
    }

    /**
     * A line that changed. Emits one row per changed field, and none at all for a resend.
     *
     * `$before` is the line's state *before* `forceFill`, so the caller must snapshot it first —
     * which is why this takes an array and not the model twice.
     *
     * @param  array<string, mixed>  $before  raw attributes as they were
     * @param  array<string, mixed>  $after  the update that was applied
     */
    public function lineChanged(
        PosConfig $config,
        Order $order,
        OrderLine $line,
        array $before,
        array $after,
        ?int $employeeId = null,
        PosDevice|int|null $device = null,
    ): void {
        if (! $this->enabled($config)) {
            return;
        }

        $changes = AuditRecorder::diff($before, $after);

        foreach (self::Tracked as $field => $action) {
            if (! isset($changes[$field])) {
                continue;
            }

            $old = $changes[$field]['old'];
            $new = $changes[$field]['new'];

            $this->write($order, $line, $line->uuid, $this->actionFor($field, $action, $old, $new), [
                'old_value' => $this->trim($this->scalar($old)),
                'new_value' => $this->trim($this->scalar($new)),
                'amount_impact' => $this->impactOf($field, $line, $before, $old, $new),
            ], $employeeId, $device);
        }
    }

    /**
     * A line taken off the ticket.
     *
     * The row outlives the line: `pos_order_line_id` is nulled by the FK when the row goes, which is
     * exactly why `pos_order_line_uuid` is a plain char column beside it. Without that, deleting the
     * line would erase the only evidence that it was ever there — the single most useful fact in
     * the table.
     */
    public function lineRemoved(
        PosConfig $config,
        Order $order,
        OrderLine $line,
        ?int $employeeId = null,
        PosDevice|int|null $device = null,
    ): void {
        if (! $this->enabled($config)) {
            return;
        }

        $this->write($order, $line, $line->uuid, OrderEditAction::LineRemoved, [
            'old_value' => $this->trim((string) $line->quantity),
            'amount_impact' => '-'.ltrim($this->extended($line), '-'),
        ], $employeeId, $device);
    }

    /** A payment whose amount moved, or one added or removed outright. */
    public function paymentChanged(
        PosConfig $config,
        Order $order,
        ?string $oldAmount,
        ?string $newAmount,
        ?string $label = null,
        ?int $employeeId = null,
        PosDevice|int|null $device = null,
    ): void {
        if (! $this->enabled($config)) {
            return;
        }

        if ($oldAmount !== null && $newAmount !== null && bccomp($oldAmount, $newAmount, 4) === 0) {
            return;
        }

        $this->write($order, null, null, OrderEditAction::PaymentChanged, [
            'product_name' => $label,
            'old_value' => $oldAmount === null ? null : $this->trim($oldAmount),
            'new_value' => $newAmount === null ? null : $this->trim($newAmount),
            'amount_impact' => bcsub($newAmount ?? '0', $oldAmount ?? '0', 4),
        ], $employeeId, $device);
    }

    /** The whole ticket withdrawn. `amount_impact` is the order total, negated. */
    public function orderCancelled(
        PosConfig $config,
        Order $order,
        ?int $employeeId = null,
        PosDevice|int|null $device = null,
    ): void {
        if (! $this->enabled($config)) {
            return;
        }

        $this->write($order, null, null, OrderEditAction::OrderCancelled, [
            'old_value' => $this->trim((string) $order->amount_total),
            'amount_impact' => '-'.ltrim((string) $order->amount_total, '-'),
        ], $employeeId, $device);
    }

    // ------------------------------------------------------------------ internals

    /**
     * A quantity change is two different findings depending on its direction, and only one of them
     * is interesting: a decrease is the fraud shape.
     */
    private function actionFor(string $field, OrderEditAction $default, mixed $old, mixed $new): OrderEditAction
    {
        if ($field !== 'quantity') {
            return $default;
        }

        return bccomp((string) $new, (string) $old, 6) < 0
            ? OrderEditAction::QtyDecreased
            : OrderEditAction::QtyIncreased;
    }

    /**
     * What this edit was worth, signed: negative took money off the ticket.
     *
     * Computed from the line as it was, because that is the ticket the customer was shown. A
     * discount raised from 0 to 100% on a €20 line is −€20 whatever the line becomes afterwards.
     *
     * @param  array<string, mixed>  $before
     */
    private function impactOf(string $field, OrderLine $line, array $before, mixed $old, mixed $new): string
    {
        $unit = $this->unitPrice(
            (string) ($before['price_unit'] ?? $line->price_unit),
            (string) ($before['price_extra'] ?? $line->price_extra),
            (string) ($before['discount_percent'] ?? $line->discount_percent),
        );
        $qty = (string) ($before['quantity'] ?? $line->quantity);

        return match ($field) {
            // (new − old) at the price the line was carrying.
            'quantity' => bcmul(bcsub((string) $new, (string) $old, 6), $unit, 4),

            // A price move applies to every unit on the line.
            'price_unit' => bcmul(bcsub((string) $new, (string) $old, 6), $qty, 4),

            // A discount *increase* removes revenue, hence the negation.
            'discount_percent' => bcmul(
                bcmul(bcdiv(bcsub((string) $old, (string) $new, 6), '100', 8), $qty, 6),
                $this->unitPrice(
                    (string) ($before['price_unit'] ?? $line->price_unit),
                    (string) ($before['price_extra'] ?? $line->price_extra),
                    '0',
                ),
                4,
            ),

            // A note costs nothing.
            default => '0.0000',
        };
    }

    /** qty × (price_unit + price_extra) × (1 − discount). */
    private function extended(OrderLine $line): string
    {
        return bcmul(
            (string) $line->quantity,
            $this->unitPrice((string) $line->price_unit, (string) $line->price_extra, (string) $line->discount_percent),
            4,
        );
    }

    private function unitPrice(string $priceUnit, string $priceExtra, string $discountPercent): string
    {
        $gross = bcadd($priceUnit, $priceExtra === '' ? '0' : $priceExtra, 6);

        return bcmul($gross, bcsub('1', bcdiv($discountPercent === '' ? '0' : $discountPercent, '100', 8), 8), 6);
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function write(
        Order $order,
        ?OrderLine $line,
        ?string $lineUuid,
        OrderEditAction $action,
        array $row,
        ?int $employeeId,
        PosDevice|int|null $device,
    ): void {
        OrderEditLog::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_order_id' => $order->getKey(),
            'pos_order_line_id' => $line?->getKey(),
            'pos_order_line_uuid' => $lineUuid,
            'action' => $action->value,
            'product_name' => $row['product_name'] ?? $line?->full_product_name,
            'old_value' => $row['old_value'] ?? null,
            'new_value' => $row['new_value'] ?? null,
            'amount_impact' => $row['amount_impact'] ?? '0',
            'employee_id' => $employeeId ?? $order->employee_id,
            'pos_device_id' => $device instanceof PosDevice ? $device->getKey() : $device,
            'occurred_at' => now(),
        ]);
    }

    private function scalar(mixed $value): string
    {
        return match (true) {
            $value === null => '',
            is_bool($value) => $value ? '1' : '0',
            is_scalar($value) => (string) $value,
            default => (string) json_encode($value),
        };
    }

    /**
     * Render a logged value the same way whichever path produced it.
     *
     * The two sides of a row arrive from different places: `old_value` from the column (where the
     * `decimal:3` cast pads it to `3.000`) and `new_value` from the client (which sent `1`). Left
     * alone, a single row reads `3.000 → 1`, and the same quantity is rendered two ways depending on
     * which code path wrote it — a deleted line said `2.000` where a reduced one said `2`. Nothing
     * downstream *breaks* on that, which is exactly why it would have survived: it is a report a
     * person reads, and it would simply have read badly forever.
     *
     * Trailing zeros are dropped rather than added, because these are read as quantities and prices,
     * not as fixed-scale money — `3 → 1` is what a manager wants on the line.
     *
     * Also the length guard: the columns are `string(96)` and a pasted note will not fit.
     */
    private function trim(string $value): string
    {
        if (is_numeric($value) && str_contains($value, '.')) {
            $value = rtrim(rtrim($value, '0'), '.');

            // `rtrim` on '0.000' leaves the empty string.
            $value = $value === '' || $value === '-' ? '0' : $value;
        }

        return mb_substr($value, 0, 96);
    }
}
