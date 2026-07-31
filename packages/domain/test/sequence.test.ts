import { describe, expect, it } from 'vitest';

import {
    TOKEN_ALPHABET,
    createMemoryCounterStore,
    devicePrefix,
    formatOrderReference,
    formatTrackingNumber,
    generateReceiptToken,
    generateUuid,
    nextOrderReference,
    SEQ_ORDER,
} from '../src/sequence/index';

/** Unit coverage for docs/spec/03-architecture.md §6. */

const device = { device_seq: 3, config_id: 3 };
const NEW_YEAR_2026 = new Date('2026-01-01T00:00:00Z');

describe('order reference', () => {
    it('formats {YY}D{deviceSeq:02}-{configId}-{counter:06}', () => {
        expect(formatOrderReference(device, 412, NEW_YEAR_2026)).toBe('26D03-3-000412');
    });

    it('pads the counter to six digits and the device to two', () => {
        expect(formatOrderReference({ device_seq: 1, config_id: 12 }, 1, NEW_YEAR_2026)).toBe('26D01-12-000001');
    });

    it('is monotonic and never recycles a counter', async () => {
        const store = createMemoryCounterStore();
        const first = await nextOrderReference(store, device, NEW_YEAR_2026);
        const second = await nextOrderReference(store, device, NEW_YEAR_2026);
        expect(first.counter).toBe(1);
        expect(second.counter).toBe(2);
        expect(first.reference).not.toBe(second.reference);
        expect(await store.get(SEQ_ORDER)).toBe(2);
    });

    it('cannot collide across devices: the namespaces are disjoint', async () => {
        const a = createMemoryCounterStore();
        const b = createMemoryCounterStore();
        const refA = await nextOrderReference(a, { device_seq: 1, config_id: 3 }, NEW_YEAR_2026);
        const refB = await nextOrderReference(b, { device_seq: 2, config_id: 3 }, NEW_YEAR_2026);
        expect(refA.counter).toBe(refB.counter); // same counter…
        expect(refA.reference).not.toBe(refB.reference); // …different reference
    });

    it('changes the year segment across a year boundary, so a wiped device cannot reuse a reference', () => {
        const y2026 = formatOrderReference(device, 5, new Date('2026-06-01T10:00:00'));
        const y2027 = formatOrderReference(device, 5, new Date('2027-06-01T10:00:00'));
        expect(y2026.startsWith('26D')).toBe(true);
        expect(y2027.startsWith('27D')).toBe(true);
        expect(y2026).not.toBe(y2027);
    });
});

describe('tracking number', () => {
    it('is the counter mod 1000, three digits', () => {
        expect(formatTrackingNumber(412, { deviceSeq: 1 })).toBe('412');
        expect(formatTrackingNumber(1412, { deviceSeq: 1 })).toBe('412');
        expect(formatTrackingNumber(7, { deviceSeq: 1 })).toBe('007');
    });

    it('prefixes per device when the config has more than one register', () => {
        expect(formatTrackingNumber(412, { deviceSeq: 1, multiDevice: true })).toBe('A412');
        expect(formatTrackingNumber(412, { deviceSeq: 2, multiDevice: true })).toBe('B412');
    });

    it('uses K for kiosk and S for mobile self-order, matching Odoo', () => {
        expect(formatTrackingNumber(412, { deviceSeq: 5, source: 'kiosk' })).toBe('K412');
        expect(formatTrackingNumber(412, { deviceSeq: 5, source: 'mobile' })).toBe('S412');
        expect(devicePrefix(1)).toBe('A');
        expect(devicePrefix(26)).toBe('Z');
        expect(devicePrefix(27)).toBe('A');
    });
});

describe('receipt token', () => {
    it('is 5 characters from an unambiguous alphabet', () => {
        const token = generateReceiptToken();
        expect(token).toHaveLength(5);
        for (const ch of token) expect(TOKEN_ALPHABET).toContain(ch);
    });

    it('excludes 0, O, 1 and I', () => {
        for (const ch of '01OI') expect(TOKEN_ALPHABET).not.toContain(ch);
    });

    it('is deterministic given a deterministic random source', () => {
        const zeros = (n: number): Uint8Array => new Uint8Array(n);
        expect(generateReceiptToken(zeros)).toBe('22222');
    });

    it('spreads evenly over the alphabet (no modulo bias: 256 % 32 === 0)', () => {
        const counts = new Map<string, number>();
        let i = 0;
        const cycling = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => i++ % 256);
        for (let k = 0; k < 256; k++) {
            for (const ch of generateReceiptToken(cycling, 1)) {
                counts.set(ch, (counts.get(ch) ?? 0) + 1);
            }
        }
        expect(counts.size).toBe(32);
        expect(new Set(counts.values())).toEqual(new Set([8]));
    });
});

describe('uuid', () => {
    it('produces a well-formed v4 uuid', () => {
        const uuid = generateUuid();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('sets the version and variant bits even from an all-zero source', () => {
        expect(generateUuid((n) => new Uint8Array(n))).toBe('00000000-0000-4000-8000-000000000000');
    });
});
