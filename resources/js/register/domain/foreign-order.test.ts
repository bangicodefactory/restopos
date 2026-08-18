import type { OrderRow, PosConfigRow } from '@domain/types';
import { describe, expect, it } from 'vitest';

import { canOpenOrder, foreignOrder, isForeign } from './foreign-order';

/**
 * REG-373, REG-374 (BAN-523) — orders belonging to another register.
 *
 * `DeltaService::orderDelta()` hands this till every draft on its trusted peers, which is the point:
 * a bill started on the terrace till can be picked up at the bar. The rows arrive looking exactly
 * like local ones — same columns, same amounts, and no unit anywhere on an order row.
 *
 * That is fine until a peer runs a different currency. Then `24.20` on screen is 24.20 of something
 * else, the payment screen offers this register's tenders against it, and the sale balances to a
 * number that was never the price. The arithmetic stays internally consistent the whole way, so
 * nothing downstream can catch it.
 */

const HOME = 1;
const SAME_CURRENCY = 2;
const OTHER_CURRENCY = 3;
const EUR = 10;
const GBP = 20;

function config(): PosConfigRow {
    return {
        id: HOME,
        currency_id: EUR,
        trusted_configs: [
            { id: SAME_CURRENCY, name: 'Terrace', currency_id: EUR },
            { id: OTHER_CURRENCY, name: 'Duty Free', currency_id: GBP },
        ],
    } as PosConfigRow;
}

function order(configId: number): OrderRow {
    return { uuid: 'order-1', pos_config_id: configId } as OrderRow;
}

describe('this register own orders', () => {
    it('are not foreign, and carry no badge', () => {
        expect(foreignOrder(order(HOME), config())).toBeNull();
        expect(isForeign(order(HOME), config())).toBe(false);
    });

    it('can be opened', () => {
        expect(canOpenOrder(order(HOME), config())).toBe(true);
    });
});

describe('a trusted peer on the same currency', () => {
    it('is marked with the register it came from', () => {
        expect(foreignOrder(order(SAME_CURRENCY), config())).toEqual({
            registerName: 'Terrace',
            openable: true,
        });
    });

    it('opens normally, because that is what trusting a register is for', () => {
        expect(canOpenOrder(order(SAME_CURRENCY), config())).toBe(true);
    });
});

describe('a trusted peer on another currency', () => {
    it('is named, so the message can say where to go instead', () => {
        expect(foreignOrder(order(OTHER_CURRENCY), config())).toEqual({
            registerName: 'Duty Free',
            openable: false,
        });
    });

    it('cannot be opened', () => {
        expect(canOpenOrder(order(OTHER_CURRENCY), config())).toBe(false);
    });
});

describe('an order from a register this till does not know', () => {
    it('is foreign and unopenable rather than assumed safe', () => {
        // It should not have reached this till at all. Shown rather than hidden: an order the
        // register cannot account for is worth putting on screen, and treating it as editable is the
        // one reading with a downside.
        expect(foreignOrder(order(999), config())).toEqual({ registerName: null, openable: false });
        expect(canOpenOrder(order(999), config())).toBe(false);
    });
});

describe('before the config has loaded', () => {
    it('treats nothing as foreign, rather than everything', () => {
        // A cold start with no config yet must not paint every row with a badge and refuse to open
        // any of them; there is simply nothing to compare against.
        expect(foreignOrder(order(HOME), null)).toBeNull();
        expect(canOpenOrder(order(OTHER_CURRENCY), null)).toBe(true);
    });
});
