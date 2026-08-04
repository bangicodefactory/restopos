import { afterEach, expect, it } from 'vitest';

import { useSelfOrderStore } from './store';

/**
 * BAN-450 — the store's `offline` flag is wired to live network events, so the online-only guards
 * (submit) and the disabled checkout buttons react the instant connectivity changes, not just after
 * the next failed fetch.
 */
afterEach(() => {
    useSelfOrderStore.getState().setOffline(false);
    useSelfOrderStore.setState({ submitError: null });
});

it('tracks the live offline state', () => {
    const store = useSelfOrderStore;

    store.getState().setOffline(true);
    expect(store.getState().offline).toBe(true);

    store.getState().setOffline(false);
    expect(store.getState().offline).toBe(false);
});

it('clears a stale offline submit error on reconnect', () => {
    const store = useSelfOrderStore;

    store.getState().setOffline(true);
    store.setState({ submitError: 'so.error.offline' });

    store.getState().setOffline(false);

    expect(store.getState().submitError).toBeNull();
});

it('leaves a non-offline error alone on reconnect', () => {
    const store = useSelfOrderStore;

    store.getState().setOffline(true);
    store.setState({ submitError: 'so.checkout.failed' });

    store.getState().setOffline(false);

    expect(store.getState().submitError).toBe('so.checkout.failed');
});
