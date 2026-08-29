import type { PaymentMethodRow, PaymentRow } from '@domain/types';

import type { TerminalDriver, TerminalResult } from '../terminal';

/**
 * A terminal that lives in memory (XCT-060).
 *
 * The vendor driver is deferred — there is no device, no SDK and no credentials anywhere in
 * `config/` — so this is what the registry is proved against. It is deliberately **not** a stub that
 * always says yes: every verb can be programmed to accept, to refuse, or to throw, because the
 * failure branches are the half of the contract that costs money, and a double is only worth having
 * if it can behave badly.
 *
 * It records every call so a test can assert not only what came back but *that the driver was
 * reached at all* — the guards in `terminal.ts` refuse several operations before the driver is
 * consulted, and "the guard fired" and "the driver said no" are indistinguishable from the result
 * alone.
 */

export type TerminalVerb = 'send' | 'cancel' | 'reverse' | 'adjust' | 'status';

export type TerminalCall = {
    readonly verb: TerminalVerb;
    readonly paymentUuid: string;
    /** The tip, for `adjust`; the method's id, for `send`. Absent otherwise. */
    readonly argument?: string;
};

/** What the fake does when a verb is invoked: answer, refuse, or blow up. */
type Behaviour = TerminalResult | 'throw';

const ACCEPTED: TerminalResult = {
    ok: true,
    status: 'done',
    metadata: {
        card_brand: 'visa',
        card_last4: '4242',
        auth_code: 'A12345',
        transaction_reference: 'txn_987',
        terminal_ticket: 'MERCHANT COPY\nVISA ****4242\nAPPROVED',
    },
};

export class FakeTerminal implements TerminalDriver {
    readonly calls: TerminalCall[] = [];

    private readonly behaviours = new Map<TerminalVerb, Behaviour>();

    constructor(readonly provider: string = 'acme') {}

    /** Program one verb. Anything not programmed accepts with the default metadata. */
    willRespond(verb: TerminalVerb, behaviour: Behaviour): this {
        this.behaviours.set(verb, behaviour);

        return this;
    }

    /** Did the driver see this verb at all? The guards refuse several before it is reached. */
    sawVerb(verb: TerminalVerb): boolean {
        return this.calls.some((call) => call.verb === verb);
    }

    send(payment: PaymentRow, method: PaymentMethodRow): Promise<TerminalResult> {
        return this.record('send', payment, String(method.id));
    }

    cancel(payment: PaymentRow): Promise<TerminalResult> {
        return this.record('cancel', payment);
    }

    reverse(payment: PaymentRow): Promise<TerminalResult> {
        return this.record('reverse', payment);
    }

    adjust(payment: PaymentRow, tip: string): Promise<TerminalResult> {
        return this.record('adjust', payment, tip);
    }

    status(payment: PaymentRow): Promise<TerminalResult> {
        return this.record('status', payment);
    }

    private record(verb: TerminalVerb, payment: PaymentRow, argument?: string): Promise<TerminalResult> {
        this.calls.push({ verb, paymentUuid: payment.uuid, ...(argument === undefined ? {} : { argument }) });

        const behaviour = this.behaviours.get(verb) ?? defaultFor(verb);

        if (behaviour === 'throw') return Promise.reject(new Error(`terminal exploded on ${verb}`));

        return Promise.resolve(behaviour);
    }
}

/**
 * What each verb answers when a test has not said otherwise.
 *
 * Per-verb rather than one shared `done`, because a cancel that reports `done` is nonsense and a
 * test written against it would assert the wrong transition without noticing.
 */
function defaultFor(verb: TerminalVerb): TerminalResult {
    switch (verb) {
        case 'cancel':
            return { ok: true, status: 'cancelled' };
        case 'reverse':
            return { ok: true, status: 'reversed' };
        case 'send':
        case 'adjust':
        case 'status':
            return ACCEPTED;
    }
}
