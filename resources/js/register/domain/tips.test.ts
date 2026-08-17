import type { PaymentRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { tipDelta, tipTopUp } from './tips';

/**
 * RST-125 (BAN-494) — which tender a tip lands on.
 *
 * A tip is applied after the receipt prints, so the tip line raises the total of an order that is
 * already settled. Without moving a payment to match, the till shows a closed sale that owes money
 * and the session's takings come up short of what the acquirer really charged — a probe on the
 * server showed exactly that: `total 14.10, paid 12.10, due 2.00`.
 *
 * The server opens one narrow door for the correction. This is the client aiming at the same target:
 * pick the wrong tender and the push is refused while the screen says it worked.
 */

let counter = 0;

function payment(amount: string, overrides: Partial<PaymentRow> = {}): PaymentRow {
    counter += 1;

    return {
        uuid: `pay-${counter}`,
        amount,
        is_change: false,
        is_refund: false,
        payment_status: 'done',
        ...overrides,
    } as PaymentRow;
}

describe('choosing the tender', () => {
    it('tops up the only payment', () => {
        const card = payment('12.10');

        expect(tipTopUp([card], '2.00')).toEqual({ paymentUuid: card.uuid, amount: '14.10' });
    });

    it('puts the tip on the larger card of a split tender', () => {
        // The closest thing to a rule a waiter would recognise: it goes on the card that paid for
        // most of the meal.
        const small = payment('4.00');
        const large = payment('8.10');

        expect(tipTopUp([small, large], '2.00')?.paymentUuid).toBe(large.uuid);
    });

    it('ignores the change line even when it is the largest row', () => {
        // Change is money going the other way; topping it up shrinks the takings by the tip instead
        // of growing them.
        //
        // The amounts are deliberate. An ordinary change row is negative, so a test using one passes
        // whether or not the filter exists — the largest-tender rule picks the real payment anyway,
        // and removing the filter changes nothing. Only a change row that would *win* that rule
        // makes the filter load-bearing.
        const card = payment('12.10');
        const change = payment('99.00', { is_change: true });

        expect(tipTopUp([change, card], '2.00')?.paymentUuid).toBe(card.uuid);
    });

    it('ignores a refund line', () => {
        const card = payment('12.10');
        const refund = payment('30.00', { is_refund: true });

        expect(tipTopUp([refund, card], '2.00')?.paymentUuid).toBe(card.uuid);
    });

    it('ignores a tender that never captured', () => {
        // A failed or cancelled authorisation took no money; topping it up would invent some.
        const failed = payment('50.00', { payment_status: 'failed' });
        const card = payment('12.10');

        expect(tipTopUp([failed, card], '2.00')?.paymentUuid).toBe(card.uuid);
    });

    it('asks for nothing when there is no tender to top up', () => {
        expect(tipTopUp([], '2.00')).toBeNull();
        expect(tipTopUp([payment('-5.00', { is_change: true })], '2.00')).toBeNull();
    });

    it('asks for nothing when the tip did not move', () => {
        expect(tipTopUp([payment('12.10')], '0.00')).toBeNull();
    });
});

describe('taking a tip back off', () => {
    it('lowers the tender it was added to', () => {
        const card = payment('14.10');

        expect(tipTopUp([card], '-2.00')).toEqual({ paymentUuid: card.uuid, amount: '12.10' });
    });

    it('refuses to drive a tender negative', () => {
        // A negative tender reads as a refund on a settled sale, which is a different document with
        // different rules — not something a mistyped tip should be able to produce.
        expect(tipTopUp([payment('1.00')], '-5.00')).toBeNull();
    });
});

describe('how much the tip moved', () => {
    it('is the difference from what the order already recorded', () => {
        expect(tipDelta('2.00', '5.00')).toBe('3.00');
        expect(tipDelta('5.00', '2.00')).toBe('-3.00');
    });

    it('treats a never-tipped order as zero', () => {
        expect(tipDelta(null, '2.00')).toBe('2.00');
        expect(tipDelta(undefined, '2.00')).toBe('2.00');
    });

    it('is zero for a re-application of the same amount', () => {
        // Which is what stops a resend stacking another tip onto the card.
        expect(tipDelta('2.00', '2.00')).toBe('0.00');
    });
});
