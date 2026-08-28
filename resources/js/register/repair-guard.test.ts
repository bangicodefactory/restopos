/**
 * "Repair local data" must refuse while sales are unsynced (XCT-014, BAN-405).
 *
 * `reloadData` re-runs bootstrap and re-hydrates Dexie. It shipped with no guard at all — and with
 * exactly one occurrence in the tree, its own definition, so nothing could reach it to find out.
 * Now that it is a button the guard is the whole safety of it: repair is what a cashier presses
 * precisely when something already looks wrong, which is exactly when a full re-hydrate against a
 * server that has never seen those sales would lose them without a word.
 *
 * Refusal and failure are deliberately told apart here. Both are `ok: false`, so a test that only
 * checked `ok` would pass just as happily if the guard were deleted and the network simply failed.
 * `fetch` is stubbed to reject: a refusal must come back *without* it ever being called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadData } from './boot';
import { useOrderStore } from './state/order-store';

const fetchSpy = vi.fn(async () => {
    throw new Error('network disabled in this test');
});

function seedOrder(uuid: string, syncState: string, state = 'draft'): void {
    useOrderStore.setState((current) => ({
        ...current,
        orders: { ...current.orders, [uuid]: { uuid, syncState, state } as never },
    }));
}

beforeEach(() => {
    useOrderStore.getState().resetAll();
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('repair local data', () => {
    it('refuses while a sale has not reached the server, and says how many', async () => {
        seedOrder('a', 'pending');
        seedOrder('b', 'error');

        await expect(reloadData()).resolves.toEqual({ ok: false, unsynced: 2 });

        // The refusal has to happen before anything is fetched, or "repair" would already have
        // begun replacing the local data it was refusing to replace.
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not count a cancelled order as an unsynced sale', async () => {
        // A cancelled order is never going to sync and must not wedge the repair button shut.
        seedOrder('a', 'pending', 'cancelled');

        const result = await reloadData();

        // It got past the guard and tried — which is the assertion. That the attempt then failed is
        // the stubbed network, not the guard.
        expect(result).not.toEqual({ ok: false, unsynced: 1 });
    });

    it('lets everything-synced through to the actual reload', async () => {
        seedOrder('a', 'synced');

        await expect(reloadData()).resolves.toEqual({ ok: false, unsynced: 0 });
    });

    it('can be forced past the guard, which is what the boot-screen path needs', async () => {
        seedOrder('a', 'pending');

        // `unsynced: 0` is the "tried and failed" shape, not the refusal shape (`unsynced: 1`).
        await expect(reloadData(true)).resolves.toEqual({ ok: false, unsynced: 0 });
    });
});
