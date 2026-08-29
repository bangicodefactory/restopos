import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { customerDisplayUrl } from './customer-display-link';
import {
    DISPLAY_CHANNEL,
    DISPLAY_EVENT,
    closeDisplay,
    createDisplayRelay,
    displayChannel,
    displayConfigIdFromUrl,
    displayTokenFromUrl,
    isDisplayPayload,
    publishDisplay,
    readDisplayBroadcast,
    setDisplayRelay,
    subscribeDisplay,
    type DisplayPayload,
} from './customer-display-bus';

/**
 * The customer display's two transports (REG-351, REG-352, BAN-443a).
 *
 * Placed here rather than at `tests/js/register/…`, which is where the ticket asked for it and
 * where `vitest.config.ts` does not look. A test outside the include list does not fail — it never
 * runs, and the thing it was written to protect is protected by nothing.
 *
 * The two legs are tested as two different things on purpose, because they carry different risks.
 * `BroadcastChannel` is same-origin and same-machine, so what it delivers is what this bundle
 * posted; the socket leg carries a frame off the network onto a screen that has no replica to
 * recover from, so the guard that rejects a malformed frame is the load-bearing part.
 */

type Posted = { name: string; data: unknown };

let posted: Posted[] = [];
let listeners: { name: string; channel: FakeChannel }[] = [];

class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;

    constructor(readonly name: string) {
        listeners.push({ name, channel: this });
    }

    postMessage(data: unknown): void {
        posted.push({ name: this.name, data });
        for (const entry of listeners) {
            if (entry.channel !== this && entry.name === this.name) entry.channel.onmessage?.({ data });
        }
    }

    close(): void {
        this.closed = true;
        listeners = listeners.filter((entry) => entry.channel !== this);
    }
}

const orderFrame: DisplayPayload = {
    kind: 'order',
    venue: 'Trattoria',
    lines: [{ name: 'Margherita', quantity: 2, unitPrice: '9.0000', total: '18.0000', note: null }],
    subtotal: '15.0000',
    tax: '3.0000',
    total: '18.0000',
    paid: '0.0000',
    due: '18.0000',
    change: '0.0000',
    currency: {
        symbol: '€',
        position: 'after',
        decimalPlaces: 2,
        decimalSeparator: ',',
        thousandsSeparator: ' ',
    },
    at: 1,
};

beforeEach(() => {
    posted = [];
    listeners = [];
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
});

afterEach(() => {
    closeDisplay();
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
});

describe('the same-machine transport (REG-351)', () => {
    it('posts every frame on the display channel', () => {
        publishDisplay(orderFrame);

        expect(posted).toEqual([{ name: DISPLAY_CHANNEL, data: orderFrame }]);
    });

    it('delivers to a subscriber on the same channel', () => {
        const seen: DisplayPayload[] = [];
        const stop = subscribeDisplay((payload) => seen.push(payload));

        publishDisplay(orderFrame);

        expect(seen).toEqual([orderFrame]);

        stop();
        publishDisplay({ kind: 'idle', venue: null, at: 2 });

        // Unsubscribed means unsubscribed: a display window that was closed must not keep a handler
        // alive against a channel the register is still posting on.
        expect(seen).toHaveLength(1);
    });

    it('keeps working with no BroadcastChannel at all', () => {
        delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

        // The register must not throw on a browser without it — the mirror is a nicety, the till is
        // not. Nothing is delivered, and nothing breaks.
        expect(() => publishDisplay(orderFrame)).not.toThrow();
        expect(subscribeDisplay(() => {})).toBeTypeOf('function');
    });
});

describe('the remote transport (REG-352)', () => {
    it('names the channel the server broadcasts on', () => {
        // Asserted against the literal, and `tests/Feature/Pos/CustomerDisplayTest.php` asserts the
        // same literal against `CustomerDisplayUpdated::broadcastOn()`. A channel name agreed only
        // by inspection is a name that drifts and fails silently — the subscription succeeds and
        // nothing ever arrives.
        expect(displayChannel('abc123')).toBe('pos.display.abc123');
        expect(DISPLAY_EVENT).toBe('.display.update');
    });

    it('sends the same frame to the relay as to the local channel', () => {
        const sent: DisplayPayload[] = [];
        setDisplayRelay({ push: (payload) => sent.push(payload), stop: () => {} });

        publishDisplay(orderFrame);

        expect(sent).toEqual([orderFrame]);
        expect(posted).toHaveLength(1);
    });

    it('stops relaying once the relay is removed', () => {
        const sent: DisplayPayload[] = [];
        const stop = vi.fn();
        setDisplayRelay({ push: (payload) => sent.push(payload), stop });

        setDisplayRelay(null);
        publishDisplay(orderFrame);

        // An unpaired register that kept relaying would keep driving a display it no longer owns.
        expect(stop).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);
        expect(posted).toHaveLength(1);
    });
});

describe('the relay throttle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends the first frame immediately', () => {
        const send = vi.fn();
        const relay = createDisplayRelay({ send, minIntervalMs: 250 });

        relay.push(orderFrame);

        // Leading edge: the customer is watching the screen while the cashier scans, so the first
        // item of a new sale must not wait out an interval.
        expect(send).toHaveBeenCalledTimes(1);
        relay.stop();
    });

    it('collapses a burst into one trailing send carrying the newest frame', () => {
        const send = vi.fn();
        const relay = createDisplayRelay({ send, minIntervalMs: 250 });

        relay.push({ ...orderFrame, at: 1 });
        relay.push({ ...orderFrame, at: 2 });
        relay.push({ ...orderFrame, at: 3 });

        expect(send).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(250);

        // Trailing edge, and it must be the *last* frame: dropping it would leave the display one
        // item behind for good, because nothing re-sends. The middle frame is superseded and never
        // travels — one request per digit typed is what takes a venue router down.
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[0]).toMatchObject({ at: 3 });
    });

    it('sends immediately again once the window has passed with nothing pending', () => {
        const send = vi.fn();
        const relay = createDisplayRelay({ send, minIntervalMs: 250 });

        relay.push({ ...orderFrame, at: 1 });
        vi.advanceTimersByTime(250);

        expect(send).toHaveBeenCalledTimes(1);

        relay.push({ ...orderFrame, at: 2 });

        expect(send).toHaveBeenCalledTimes(2);
        relay.stop();
    });

    it('sends nothing after stop, including the frame already pending', () => {
        const send = vi.fn();
        const relay = createDisplayRelay({ send, minIntervalMs: 250 });

        relay.push({ ...orderFrame, at: 1 });
        relay.push({ ...orderFrame, at: 2 });
        relay.stop();

        vi.advanceTimersByTime(1_000);

        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('what the display will render off the network', () => {
    it('accepts each of the three frames the register sends', () => {
        expect(isDisplayPayload(orderFrame)).toBe(true);
        expect(isDisplayPayload({ kind: 'idle', venue: null, at: 1 })).toBe(true);
        expect(isDisplayPayload({ kind: 'paid', venue: 'X', total: '18.0000', change: '2.0000', at: 1 })).toBe(true);
    });

    it.each([
        ['not an object', 'nope'],
        ['null', null],
        ['an unknown kind', { kind: 'weight', venue: null, at: 1 }],
        ['no timestamp', { kind: 'idle', venue: null }],
        ['a non-string venue', { kind: 'idle', venue: 7, at: 1 }],
        ['an order with no currency', { ...orderFrame, currency: undefined }],
        ['an order with a half-built currency', { ...orderFrame, currency: { symbol: '€', position: 'after' } }],
        ['an order with a bogus currency position', { ...orderFrame, currency: { ...orderFrame.currency, position: 'above' } }],
        ['an order with no lines array', { ...orderFrame, lines: undefined }],
        ['an order with a line missing its total', { ...orderFrame, lines: [{ name: 'x', quantity: 1, note: null }] }],
        ['an order with a numeric total', { ...orderFrame, total: 18 }],
        ['a paid frame with no total', { kind: 'paid', venue: null, change: '0.0000', at: 1 }],
    ])('refuses %s', (_label, frame) => {
        // Each of these renders as a crash rather than a wrong number: `lines.map` on undefined,
        // `formatMoney` on a currency with no separators. The display has no replica to re-read
        // from and no way to recover, so the last good frame is the best available picture.
        expect(isDisplayPayload(frame)).toBe(false);
    });

    it('unwraps the broadcast envelope the event actually sends', () => {
        // `CustomerDisplayUpdated::broadcastWith()` wraps the projection one level down. A reader
        // that forgot would validate the envelope, find no `kind`, and show nothing forever.
        expect(readDisplayBroadcast({ v: 1, payload: orderFrame, emitted_by_device_uuid: null })).toEqual(orderFrame);
        expect(readDisplayBroadcast({ v: 1, payload: { kind: 'weight' } })).toBeNull();
        expect(readDisplayBroadcast(orderFrame)).toBeNull();
        expect(readDisplayBroadcast(null)).toBeNull();
    });
});

describe('the pairing URL (REG-356)', () => {
    it('round-trips through the parsers the display reads it with', () => {
        // The one wire that matters: the register writes this URL into the pairing dialog and the
        // display parses it back apart. Asserting the string alone would not notice a parser that
        // reads a different query key.
        const url = customerDisplayUrl('https://pos.example', 7, 'tok-en');

        expect(url).toBe('https://pos.example/pos/7/display?t=tok-en');
        expect(displayConfigIdFromUrl(url)).toBe(7);
        expect(displayTokenFromUrl(url)).toBe('tok-en');
    });

    it('escapes a token that would otherwise break the query', () => {
        const url = customerDisplayUrl('https://pos.example/', 7, 'a b&c=d');

        expect(displayTokenFromUrl(url)).toBe('a b&c=d');
    });

    it('still produces a working same-machine URL with no token', () => {
        const url = customerDisplayUrl('https://pos.example', 3, null);

        expect(url).toBe('https://pos.example/pos/3/display');
        expect(displayTokenFromUrl(url)).toBeNull();
        expect(displayConfigIdFromUrl(url)).toBe(3);
    });

    it('reads nothing out of a URL that is not a display URL', () => {
        expect(displayConfigIdFromUrl('https://pos.example/pos/7')).toBeNull();
        expect(displayTokenFromUrl('https://pos.example/pos/7/display?other=1')).toBeNull();
        expect(displayTokenFromUrl('https://pos.example/pos/7/display?t=')).toBeNull();
    });
});
