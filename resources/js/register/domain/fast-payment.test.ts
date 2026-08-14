import type { OrderLineRow, PaymentMethodRow, PosConfigRow } from '@domain/types';
import { asUuid } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { fastPayVerdict, fastPaymentMethods, isOneTap } from './fast-payment';

/**
 * BAN-434 / REG-209 — one-tap tender buttons on the product screen.
 *
 * `use_fast_payment` and the `is_fast_payment` pivot have been in the schema, the seeder and the
 * back-office form since the config tables were written. Nothing read either: the register's
 * `PosConfigRow` never declared them, so the flag a manager could tick did nothing at all.
 *
 * The exclusions are what make this safe rather than just fast. A terminal has a conversation to
 * hold and a split method has an amount to be told, so neither can settle in one tap; an on-account
 * or `identify_customer` method needs a name the product screen cannot prompt for. And in restaurant
 * mode the RST-143 prompt still has to fire, because fast payment is the easiest possible way to
 * settle for food the kitchen was never told about.
 */

const CASH: PaymentMethodRow = {
    id: 1,
    company_id: 1,
    name: 'Espèces',
    method_type: 'cash',
    is_cash_count: true,
    identify_customer: false,
    split_transactions: false,
    payment_provider_id: null,
    terminal_provider: null,
    image_media_id: null,
    sequence: 1,
    active: true,
};
const CARD: PaymentMethodRow = { ...CASH, id: 2, name: 'Carte', method_type: 'card_terminal', is_cash_count: false };
const VOUCHER: PaymentMethodRow = { ...CASH, id: 3, name: 'Titre', method_type: 'voucher', is_cash_count: false, split_transactions: true };
const ACCOUNT: PaymentMethodRow = { ...CASH, id: 4, name: 'Compte', method_type: 'customer_account', is_cash_count: false };
const BANK: PaymentMethodRow = { ...CASH, id: 5, name: 'Virement', method_type: 'bank', is_cash_count: false };
/** Not split, not a terminal — but it needs a name on it, and only the client enforces that. */
const IDENTIFIED: PaymentMethodRow = { ...CASH, id: 6, name: 'Titre resto', method_type: 'voucher', is_cash_count: false, identify_customer: true };
const METHODS = [CASH, CARD, VOUCHER, ACCOUNT, BANK, IDENTIFIED];

type FastConfig = Pick<PosConfigRow, 'use_fast_payment' | 'fast_payment_method_ids' | 'payment_method_ids'>;

function config(overrides: Partial<FastConfig> = {}): FastConfig {
    return {
        use_fast_payment: true,
        fast_payment_method_ids: [CASH.id],
        payment_method_ids: [CASH.id, CARD.id, VOUCHER.id, ACCOUNT.id, BANK.id, IDENTIFIED.id],
        ...overrides,
    };
}

let counter = 0;
function line(quantity: number): OrderLineRow {
    counter += 1;
    return { uuid: asUuid(`line-${counter}`), quantity } as OrderLineRow;
}

describe('which methods get a button', () => {
    it('shows nothing at all when the flag is off', () => {
        // The flag was tickable in the back office long before anything read it.
        expect(fastPaymentMethods(config({ use_fast_payment: false }), METHODS)).toEqual([]);
    });

    it('shows nothing when no config has loaded yet', () => {
        expect(fastPaymentMethods(null, METHODS)).toEqual([]);
    });

    it('shows the configured methods in the order the back office arranged them', () => {
        const shown = fastPaymentMethods(config({ fast_payment_method_ids: [BANK.id, CASH.id] }), METHODS);

        expect(shown.map((method) => method.id)).toEqual([BANK.id, CASH.id]);
    });

    it('excludes a terminal method, which has a conversation to hold', () => {
        expect(fastPaymentMethods(config({ fast_payment_method_ids: [CARD.id] }), METHODS)).toEqual([]);
    });

    it('excludes a split method, which has an amount to be told', () => {
        expect(fastPaymentMethods(config({ fast_payment_method_ids: [VOUCHER.id] }), METHODS)).toEqual([]);
    });

    it('excludes an on-account method, which needs a customer the product screen cannot ask for', () => {
        expect(fastPaymentMethods(config({ fast_payment_method_ids: [ACCOUNT.id] }), METHODS)).toEqual([]);
    });

    it('excludes a method flagged identify_customer (review of #51)', () => {
        // Nothing on the server enforces `identify_customer` — the payment screen is the only place
        // it is checked — so a one-tap button that skipped it settled the sale with nobody attached.
        expect(fastPaymentMethods(config({ fast_payment_method_ids: [IDENTIFIED.id] }), METHODS)).toEqual([]);
    });

    it('drops a method that is on the fast list but no longer on the register', () => {
        // Otherwise the button is on screen and the payment screen refuses what it tenders.
        const shown = fastPaymentMethods(
            config({ fast_payment_method_ids: [CASH.id], payment_method_ids: [CARD.id] }),
            METHODS,
        );

        expect(shown).toEqual([]);
    });

    it('ignores an id with no matching method in the replica', () => {
        expect(fastPaymentMethods(config({ fast_payment_method_ids: [999] }), METHODS)).toEqual([]);
    });
});

describe('isOneTap', () => {
    it('accepts an ordinary cash or bank method', () => {
        expect(isOneTap(CASH)).toBe(true);
        expect(isOneTap(BANK)).toBe(true);
    });

    it('rejects the four that cannot complete in a tap', () => {
        expect(isOneTap(CARD)).toBe(false);
        expect(isOneTap(VOUCHER)).toBe(false);
        expect(isOneTap(ACCOUNT)).toBe(false);
        expect(isOneTap(IDENTIFIED)).toBe(false);
    });
});

describe('what a tap should do', () => {
    it('settles an ordinary counter sale', () => {
        expect(fastPayVerdict({ lines: [line(1)], restaurant: false, unsent: 0 })).toEqual({ ok: true });
    });

    it('refuses an order with nothing on it', () => {
        expect(fastPayVerdict({ lines: [], restaurant: false, unsent: 0 })).toEqual({
            ok: false,
            reason: 'empty_order',
        });
    });

    it('treats an order of only zero-qty lines as empty', () => {
        expect(fastPayVerdict({ lines: [line(0)], restaurant: false, unsent: 0 })).toEqual({
            ok: false,
            reason: 'empty_order',
        });
    });

    it('asks about unsent kitchen changes before settling a table (RST-143)', () => {
        expect(fastPayVerdict({ lines: [line(1)], restaurant: true, unsent: 2 })).toEqual({
            ok: false,
            reason: 'ask_kitchen',
        });
    });

    it('does not ask a counter sale, which has no kitchen step to skip', () => {
        expect(fastPayVerdict({ lines: [line(1)], restaurant: false, unsent: 2 })).toEqual({ ok: true });
    });

    it('settles a table whose changes have all been sent', () => {
        expect(fastPayVerdict({ lines: [line(1)], restaurant: true, unsent: 0 })).toEqual({ ok: true });
    });
});
