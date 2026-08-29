import type { Money } from '@domain/types';

/**
 * The customer display link (REG-350 … REG-352).
 *
 * `BroadcastChannel` is the **default** transport and it works with the network off, which is the
 * whole reason it is first: the second monitor on the same machine is the common case, and a
 * customer display that goes blank when the venue Wi-Fi drops is a display nobody trusts. The
 * websocket path (REG-352, a display on another device) is a fallback, not the primary.
 *
 * Payloads are plain structured-cloneable data, which is also why the whole order model is plain
 * objects rather than class instances.
 *
 * ── The two transports are not interchangeable, and the difference is trust ──
 *
 * `BroadcastChannel` is same-origin, same-machine, and nothing outside this bundle can post on it.
 * The socket leg is the opposite: a frame arriving on `pos.display.{token}` came off the network,
 * over a channel whose only credential is its name. `isDisplayPayload` is therefore applied to that
 * leg and not to this one — the display renders money strings straight into the DOM, and a frame
 * with `lines: undefined` would take the screen down with a render error rather than showing a
 * stale total. See `subscribeDisplaySocket`.
 */

export const DISPLAY_CHANNEL = 'pos.customer_display';

/** `CustomerDisplayUpdated::broadcastAs()`, with Echo's leading dot for a custom event name. */
export const DISPLAY_EVENT = '.display.update';

/**
 * `pos.display.{customer_display_token}` — public, because the display holds no credential.
 *
 * The token is `pos_configs.customer_display_token` off the bootstrap config row, **not**
 * `access_token`: that one is on every table's self-order QR, and naming this channel with it would
 * let any guest in the room subscribe to every sale. The server derives one from the other.
 */
export function displayChannel(token: string): string {
    return `pos.display.${token}`;
}

/**
 * The capability token out of the display's own URL (`/pos/{id}/display?t=…`).
 *
 * Null when absent, which is the same-machine case: no token, no socket, `BroadcastChannel` only.
 * That is a working display, not a degraded one — it is how the second monitor has always worked.
 */
export function displayTokenFromUrl(url: string): string | null {
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const token = new URLSearchParams(query).get('t');

    return token !== null && token !== '' ? token : null;
}

/** The config id out of the display's own URL. Null when the path is not a display URL. */
export function displayConfigIdFromUrl(url: string): number | null {
    const match = /\/pos\/(\d+)\/display/.exec(url);
    const parsed = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : Number.NaN;

    return Number.isFinite(parsed) ? parsed : null;
}

export type DisplayLine = {
    name: string;
    quantity: number;
    unitPrice: Money;
    total: Money;
    note: string | null;
};

export type DisplayCurrency = {
    symbol: string;
    position: 'before' | 'after';
    decimalPlaces: number;
    decimalSeparator: string;
    thousandsSeparator: string;
};

export type DisplayPayload =
    | { kind: 'idle'; venue: string | null; at: number }
    | {
          kind: 'order';
          venue: string | null;
          lines: DisplayLine[];
          subtotal: Money;
          tax: Money;
          total: Money;
          paid: Money;
          due: Money;
          change: Money;
          currency: DisplayCurrency;
          at: number;
      }
    | { kind: 'paid'; venue: string | null; total: Money; change: Money; at: number };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isLine(value: unknown): value is DisplayLine {
    return (
        isRecord(value) &&
        typeof value['name'] === 'string' &&
        typeof value['quantity'] === 'number' &&
        typeof value['total'] === 'string' &&
        (value['note'] === null || typeof value['note'] === 'string')
    );
}

function isCurrency(value: unknown): value is DisplayCurrency {
    return (
        isRecord(value) &&
        typeof value['symbol'] === 'string' &&
        (value['position'] === 'before' || value['position'] === 'after') &&
        typeof value['decimalPlaces'] === 'number' &&
        typeof value['decimalSeparator'] === 'string' &&
        typeof value['thousandsSeparator'] === 'string'
    );
}

/**
 * Is this something the display can render?
 *
 * Applied to the socket leg only. The display has no local replica and no way to re-fetch, so a
 * malformed frame has no recovery path — the honest response is to keep showing the last good one.
 * Rendering it instead means `payload.lines.map` on `undefined`, which is a white screen in front
 * of a customer that only a power cycle clears.
 *
 * The checks are the fields the component actually reads: `formatMoney` needs a real currency
 * shape, and each of the three `kind`s reads a different set. A `paid` frame carrying no `total`
 * would render `Thank you` over an empty price, which is worse than the previous frame.
 */
export function isDisplayPayload(value: unknown): value is DisplayPayload {
    if (!isRecord(value)) return false;
    if (typeof value['at'] !== 'number') return false;
    if (!(value['venue'] === null || typeof value['venue'] === 'string')) return false;

    if (value['kind'] === 'idle') return true;

    if (value['kind'] === 'paid') {
        return typeof value['total'] === 'string' && typeof value['change'] === 'string';
    }

    if (value['kind'] !== 'order') return false;

    return (
        Array.isArray(value['lines']) &&
        value['lines'].every(isLine) &&
        typeof value['subtotal'] === 'string' &&
        typeof value['tax'] === 'string' &&
        typeof value['total'] === 'string' &&
        typeof value['paid'] === 'string' &&
        typeof value['due'] === 'string' &&
        typeof value['change'] === 'string' &&
        isCurrency(value['currency'])
    );
}

type Channel = { postMessage(payload: DisplayPayload): void; close(): void };

let channel: Channel | null = null;

function open(): Channel | null {
    if (channel) return channel;
    const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
    if (!Ctor) return null;
    channel = new Ctor(DISPLAY_CHANNEL);
    return channel;
}

export type DisplayRelay = {
    /** Offer a frame. May be dropped in favour of a newer one; never queued behind an older one. */
    push(payload: DisplayPayload): void;
    stop(): void;
};

/**
 * The network leg's rate limiter (REG-352).
 *
 * Every keystroke on the numpad rewrites the order store, and the display mirror is subscribed to
 * it — so an un-throttled relay is one HTTP request and one broadcast per digit typed. On a venue
 * router that is how the socket falls over.
 *
 * Leading edge **and** trailing edge, both of which matter and for different reasons. Leading,
 * because the first frame of a new order must not wait out an interval — the customer is looking at
 * the screen while the cashier scans. Trailing, because the *last* frame is the one that has to
 * land: dropping it leaves the display showing a total that is one item behind forever, since
 * nothing re-sends. Anything in between is superseded and is dropped rather than queued.
 */
export function createDisplayRelay(options: {
    send: (payload: DisplayPayload) => void;
    minIntervalMs?: number;
}): DisplayRelay {
    const minIntervalMs = options.minIntervalMs ?? 250;

    let pending: DisplayPayload | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const fire = (payload: DisplayPayload): void => {
        options.send(payload);
        timer = setTimeout(() => {
            timer = null;
            const next = pending;
            pending = null;
            if (next !== null && !stopped) fire(next);
        }, minIntervalMs);
    };

    return {
        push: (payload): void => {
            if (stopped) return;
            if (timer === null) {
                fire(payload);
                return;
            }
            pending = payload;
        },
        stop: (): void => {
            stopped = true;
            pending = null;
            if (timer !== null) clearTimeout(timer);
            timer = null;
        },
    };
}

let relay: DisplayRelay | null = null;

/**
 * Install (or remove) the network leg.
 *
 * Separate from `publishDisplay` because the two legs have different owners: the
 * `BroadcastChannel` leg needs nothing and is always on, while the socket leg needs a device token
 * and a config that has been bootstrapped. The register installs this once it has both, and passing
 * `null` removes it — a register that unpairs must stop relaying.
 */
export function setDisplayRelay(next: DisplayRelay | null): void {
    if (relay !== null && relay !== next) relay.stop();
    relay = next;
}

export function publishDisplay(payload: DisplayPayload): void {
    open()?.postMessage(payload);
    relay?.push(payload);
}

export function closeDisplay(): void {
    channel?.close();
    channel = null;
    relay?.stop();
    relay = null;
}

/** The display side, same machine. Returns the unsubscribe function. */
export function subscribeDisplay(listener: (payload: DisplayPayload) => void): () => void {
    const Ctor = (
        globalThis as {
            BroadcastChannel?: new (name: string) => {
                onmessage: ((event: { data: DisplayPayload }) => void) | null;
                close(): void;
            };
        }
    ).BroadcastChannel;
    if (!Ctor) return () => {};

    const listen = new Ctor(DISPLAY_CHANNEL);
    listen.onmessage = (event): void => listener(event.data);
    return () => {
        listen.onmessage = null;
        listen.close();
    };
}

/**
 * The display side, second device: unwrap and validate one broadcast frame.
 *
 * `CustomerDisplayUpdated::broadcastWith()` wraps the projection as `{ v, payload, … }`, so the
 * frame is one level down. Returns null for anything that is not a renderable payload, and the
 * caller keeps the frame it already had — see `isDisplayPayload` for why a bad frame must not be
 * rendered rather than merely logged.
 */
export function readDisplayBroadcast(event: unknown): DisplayPayload | null {
    if (!isRecord(event)) return null;

    const payload = event['payload'];

    return isDisplayPayload(payload) ? payload : null;
}

/**
 * Drops a frame that is older than one already shown (BAN-443a review).
 *
 * The display can be fed by two transports at once — BroadcastChannel for a second monitor on the
 * same machine, the socket for one on another device — and "Open here" turns both on. They are not
 * the same speed: BroadcastChannel is synchronous and in-process, while the socket leg is throttled,
 * then an HTTP round trip, then a Reverb hop. So frame 2 can arrive locally while frame 1 is still
 * in the air, and the late copy of frame 1 would put the pre-item total back in front of a paying
 * customer until the next send caught up.
 *
 * Whole frames solve the *merge* problem. They do not solve the *ordering* one, which is what `at`
 * is for — it was on every payload variant and enforced by `isDisplayPayload` from the start, with
 * no reader.
 *
 * Stateful on purpose: the caller is a render path, and threading the high-water mark through it
 * would put the decision back in the component where it cannot be tested.
 */
export function createFrameGate(): { accept(frame: DisplayPayload): boolean } {
    let lastAt = 0;

    return {
        accept(frame: DisplayPayload): boolean {
            // `<`, not `<=`: two frames can share a millisecond, and the later of those is still the
            // one the cashier just caused. Only a strictly older frame is dropped.
            if (frame.at < lastAt) return false;

            lastAt = frame.at;

            return true;
        },
    };
}
