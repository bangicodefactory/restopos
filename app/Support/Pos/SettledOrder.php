<?php

declare(strict_types=1);

namespace App\Support\Pos;

use App\Enums\OrderState;

/**
 * What a device may still write to an order it has already settled (BAN-410, REG-218).
 *
 * ## Why this is not simply "reject everything"
 *
 * The obvious rule — a paid order is frozen, refuse every child command — breaks the till on the
 * first reprint. `buildOrderCommand` sends the *whole* order every time: every line, every payment,
 * on every push. Reprinting a receipt bumps `print_count`, which commits, which enqueues, which
 * re-sends a settled order's entire graph. Under a blanket rule every one of those lines comes back
 * `rejected` and the cashier is told a completed sale failed to sync.
 *
 * So the rule is about **change**, not about traffic: a resend that alters nothing is allowed
 * through as a no-op, and only a command that would actually move something is refused. That is the
 * same distinction the audit trail draws (BAN-413), for the same reason — the register talks far
 * more than it edits.
 *
 * ## And two things genuinely may change after settlement
 *
 * **A tip.** `setTip` does not just set `is_tipped`; it adds or updates a *line* whose product is
 * `special_kind = tip`, and `TicketScreen` offers it on past orders, which is exactly where a
 * restaurant applies one. A guard that refuses all post-settlement line writes refuses tipping.
 *
 * **The invoice flag and the customer's contact details.** Invoicing after the fact and emailing a
 * receipt are both ordinary, and both happen once the order is closed.
 *
 * Everything else — a new line, a deleted line, a changed quantity or price, any payment movement
 * at all — is refused and recorded. That combination is the fraud shape this exists for: ring up
 * €40 cash, print, then restate the payment as €30. The order still balances and the session still
 * reconciles against what was declared.
 */
final class SettledOrder
{
    /**
     * Order columns a device may still write once the order is settled.
     *
     * Deliberately short. Anything not named here is dropped with a warning rather than rejecting
     * the whole push — a stale `restaurant_table_id` riding along on a tip must not cost the tip.
     *
     * @var list<string>
     */
    public const WritableFields = [
        // A tip is applied after the receipt prints; that is what a tip is.
        'is_tipped',
        'tip_amount',
        // Invoicing after the fact (BOF/REG invoice flows).
        'to_invoice',
        // Receipt delivery and loyalty attribution, both post-payment by nature.
        'customer_id',
        'customer_email',
        'customer_phone',
    ];

    /** The verdict on one child command against a settled order. */
    public const Allow = 'allow';

    public const Noop = 'noop';

    public const Reject = 'reject';

    /**
     * Does this `pos_orders.state` close the order to ordinary edits?
     *
     * Delegates to the enum rather than restating `paid || done` here. Two definitions of "settled"
     * that have to agree, with nothing asserting they do, is how the next state added to the
     * lifecycle ends up frozen in one place and writable in the other.
     */
    public static function isSettled(string $state): bool
    {
        return OrderState::tryFrom($state)?->isSettled() ?? false;
    }

    /**
     * May a settled order move from `$from` to `$to`?
     *
     * Only forward, and only to `done`. A push claiming `cancelled` used to write straight through:
     * `updateOrder` sets `state` outside the writable-field list, so narrowing that list did nothing
     * for it. Cancelling a paid order removes it from every report while the money stays in the
     * drawer — the same divergence this guard exists to stop, reached by a shorter route. Voiding a
     * settled sale is a refund, which is a new order, not a state change on this one.
     *
     * A push repeating the state it already holds is not a transition; that is the resend.
     */
    public static function allowsTransition(string $from, string $to): bool
    {
        if ($from === $to) {
            return true;
        }

        return $from === OrderState::Paid->value && $to === OrderState::Done->value;
    }

    /**
     * Would this tip line add value, or quietly take it away?
     *
     * The exemption that lets a tip reach a settled order is a hole until this is asked. A device
     * can send a tip line with a negative price and knock €20 off an order that is already paid,
     * printed and reconciled — the exact fraud the guard around it was written to stop, walking in
     * through the door held open for tipping.
     *
     * A tip may legitimately be corrected downward or removed outright (that is a delete, handled
     * separately). What it may never be is worth less than nothing.
     */
    public static function tipIsAdditive(string $quantity, string $priceUnit, string $discountPercent): bool
    {
        foreach ([$quantity, $priceUnit, $discountPercent] as $value) {
            if (preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)$/', $value) !== 1) {
                return false;   // unreadable is not additive
            }
        }

        return bccomp($quantity, '0', 6) > 0
            && bccomp($priceUnit, '0', 6) >= 0
            && bccomp($discountPercent, '0', 6) >= 0
            && bccomp($discountPercent, '100', 6) <= 0;
    }

    /**
     * May tips reach an order that is already settled on this register?
     *
     * Two config flags, not one. `enable_tips` decides whether the venue tips at all;
     * `tip_after_payment` decides whether it does so once the sale is closed — a counter that tips
     * into the change cup and a restaurant that adds it to the card slip are different venues, and
     * only the second one needs a door in this guard. Leaving the exemption on for both hands the
     * first one a hole it has no use for.
     */
    public static function acceptsTipAfterPayment(bool $enableTips, bool $tipAfterPayment): bool
    {
        return $enableTips && $tipAfterPayment;
    }

    /**
     * Would the tips on this order come to more than the goods on it?
     *
     * A ceiling, not a tipping policy. The exemption otherwise lets a paired device add value to a
     * settled order without limit — a €10,000 "tip" on a €4 coffee is refused here not because it
     * is a bad tip but because nothing else would have stopped it. Measured against what was
     * actually sold, so it scales with the order rather than needing a number nobody will maintain.
     *
     * The real policy — caps, percentages, who may override them — belongs to the tips work
     * (BAN-494). This is the bound that stops the door standing open until then.
     */
    public static function tipWithinCeiling(string $proposedTipTotal, string $soldTotal): bool
    {
        return bccomp($proposedTipTotal, $soldTotal, 4) <= 0;
    }

    /**
     * Is this the one product kind that may join an order after it is paid?
     *
     * Keyed on `products.special_kind` rather than on a name or a category, because those are
     * tenant-editable: a venue that renames its tip product must not lose the ability to tip, and a
     * venue that names an ordinary product "Tip" must not gain the ability to append it to settled
     * orders.
     */
    public static function isTipKind(?string $specialKind): bool
    {
        return $specialKind === 'tip';
    }
}
