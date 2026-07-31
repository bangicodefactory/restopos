import type { Money } from '@domain/types';

/**
 * The customer display link (REG-350 … REG-352).
 *
 * `BroadcastChannel` is the **default** transport and it works with the network off, which is the
 * whole reason it is first: the second monitor on the same machine is the common case, and a
 * customer display that goes blank when the venue Wi-Fi drops is a display nobody trusts. The
 * websocket path (REG-352, a display on another device addressed by uuid) is a fallback, not the
 * primary.
 *
 * Payloads are plain structured-cloneable data, which is also why the whole order model is plain
 * objects rather than class instances.
 */

export const DISPLAY_CHANNEL = 'pos.customer_display';

export type DisplayLine = {
    name: string;
    quantity: number;
    unitPrice: Money;
    total: Money;
    note: string | null;
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
          currency: { symbol: string; position: 'before' | 'after'; decimalPlaces: number; decimalSeparator: string; thousandsSeparator: string };
          at: number;
      }
    | { kind: 'paid'; venue: string | null; total: Money; change: Money; at: number };

type Channel = { postMessage(payload: DisplayPayload): void; close(): void };

let channel: Channel | null = null;

function open(): Channel | null {
    if (channel) return channel;
    const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
    if (!Ctor) return null;
    channel = new Ctor(DISPLAY_CHANNEL);
    return channel;
}

export function publishDisplay(payload: DisplayPayload): void {
    open()?.postMessage(payload);
}

export function closeDisplay(): void {
    channel?.close();
    channel = null;
}

/** The display side. Returns the unsubscribe function. */
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
