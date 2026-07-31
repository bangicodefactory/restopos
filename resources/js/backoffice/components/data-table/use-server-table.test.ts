/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanParams, decodePagerLabel, toQueryString, withQuery } from '../../lib/query';

const { routerGet } = vi.hoisted(() => ({ routerGet: vi.fn() }));
vi.mock('@inertiajs/react', () => ({ router: { get: routerGet } }));

const { useServerQuery } = await import('./use-server-table');
type ServerQuery = ReturnType<typeof useServerQuery>;

/**
 * Unit coverage for the URL-is-the-table-state hook: which parameters are pushed, when the push is
 * debounced, and the rule that any filter change resets to page 1.
 */

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

function render(options: Parameters<typeof useServerQuery>[0]): { current: ServerQuery } {
    const ref = { current: null as unknown as ServerQuery };
    function Harness(): null {
        ref.current = useServerQuery(options);
        return null;
    }
    act(() => {
        root.render(createElement(Harness));
    });
    return ref;
}

/** The options object router.get was last called with. */
function lastCall(): { url: string; params: Record<string, string>; options: Record<string, unknown> } {
    const call = routerGet.mock.calls.at(-1);
    return { url: call?.[0] as string, params: call?.[1] as Record<string, string>, options: call?.[2] as Record<string, unknown> };
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('cleanParams', () => {
    it('drops nulls, undefined and blank strings so the URL never carries empty filters', () => {
        expect(
            cleanParams({ search: '', category_id: null, page: undefined, state: 'paid', limit: 25 }),
        ).toEqual({ state: 'paid', limit: '25' });
    });

    it('encodes true as 1 and drops false entirely', () => {
        expect(cleanParams({ archived: true, favourites: false })).toEqual({ archived: '1' });
    });

    it('builds a query string, or nothing at all', () => {
        expect(toQueryString({ search: 'pizza' })).toBe('?search=pizza');
        expect(toQueryString({ search: '  ' })).toBe('');
        expect(withQuery('/products', { search: 'crème' })).toBe('/products?search=cr%C3%A8me');
    });
});

describe('decodePagerLabel', () => {
    it.each([
        { input: '&laquo; Previous', expected: '« Précédent' },
        { input: 'Next &raquo;', expected: 'Suivant »' },
        { input: '&nbsp;3&nbsp;', expected: '3' },
        { input: 'A &amp; B', expected: 'A & B' },
    ])('$input → $expected', ({ input, expected }) => {
        expect(decodePagerLabel(input)).toBe(expected);
    });
});

describe('useServerQuery', () => {
    const base = { url: '/products', only: ['products'], initial: { search: 'pizza', page: 3 } };

    it('starts from the filters the controller echoed back', () => {
        const query = render(base);
        expect(query.current.params).toEqual({ search: 'pizza', page: 3 });
        expect(query.current.dirty).toBe(true);
        expect(routerGet).not.toHaveBeenCalled();
    });

    it('reports a pristine list as not dirty', () => {
        const query = render({ ...base, initial: { search: '', category_id: null } });
        expect(query.current.dirty).toBe(false);
    });

    it('pushes a partial reload with the cleaned params', () => {
        const query = render(base);
        act(() => query.current.set('category_id', 12));

        expect(routerGet).toHaveBeenCalledOnce();
        expect(lastCall().url).toBe('/products');
        expect(lastCall().params).toEqual({ search: 'pizza', category_id: '12' });
        expect(lastCall().options).toMatchObject({
            preserveState: true,
            preserveScroll: true,
            replace: true,
            only: ['products'],
        });
    });

    it('resets to page 1 on any filter change — page 7 of an unfiltered list is page 0 of a filtered one', () => {
        const query = render(base);
        act(() => query.current.set('category_id', 12));

        expect(lastCall().params['page']).toBeUndefined();
        expect(query.current.params['page']).toBeUndefined();
    });

    it('keeps an explicit page change', () => {
        const query = render({ ...base, initial: { search: 'pizza' } });
        act(() => query.current.set('page', 4));
        expect(lastCall().params).toEqual({ search: 'pizza', page: '4' });
    });

    it('debounces free-text input and pushes only the final value', () => {
        const query = render({ ...base, initial: {} });

        act(() => query.current.set('search', 'p', { debounce: true }));
        act(() => query.current.set('search', 'pi', { debounce: true }));
        act(() => query.current.set('search', 'piz', { debounce: true }));
        expect(routerGet).not.toHaveBeenCalled();

        act(() => {
            vi.advanceTimersByTime(250);
        });

        expect(routerGet).toHaveBeenCalledOnce();
        expect(lastCall().params).toEqual({ search: 'piz' });
    });

    it('applies immediately when the debounce is disabled', () => {
        const query = render({ ...base, initial: {}, debounceMs: 0 });
        act(() => query.current.set('search', 'piz', { debounce: true }));
        expect(routerGet).toHaveBeenCalledOnce();
    });

    it('merge applies several filters at once and still resets the page', () => {
        const query = render(base);
        act(() => query.current.merge({ from: '2026-07-01', to: '2026-07-31' }));

        expect(query.current.params).toMatchObject({ search: 'pizza', from: '2026-07-01', to: '2026-07-31' });
        expect(lastCall().params).toEqual({ search: 'pizza', from: '2026-07-01', to: '2026-07-31' });
        expect(lastCall().params['page']).toBeUndefined();
    });

    it('merge overwrites an existing key and can clear one', () => {
        const query = render(base);
        act(() => query.current.merge({ search: null }));

        expect(query.current.params['search']).toBeNull();
        expect(lastCall().params).toEqual({});
    });

    it('reset clears everything and pushes a bare URL', () => {
        const query = render(base);
        act(() => query.current.reset());

        expect(query.current.params).toEqual({});
        expect(query.current.dirty).toBe(false);
        expect(lastCall().params).toEqual({});
    });

    it('tracks the in-flight state from the visit callbacks', () => {
        const query = render(base);
        act(() => query.current.set('category_id', 12));

        const options = lastCall().options as { onStart: () => void; onFinish: () => void };
        act(() => options.onStart());
        expect(query.current.processing).toBe(true);

        act(() => options.onFinish());
        expect(query.current.processing).toBe(false);
    });

    it('cancels a pending debounce when the table unmounts', () => {
        const query = render({ ...base, initial: {} });
        act(() => query.current.set('search', 'piz', { debounce: true }));

        act(() => root.unmount());
        act(() => {
            vi.advanceTimersByTime(1_000);
        });

        expect(routerGet).not.toHaveBeenCalled();
        // Re-arm the root so the shared afterEach unmount stays valid.
        root = createRoot(container);
    });
});
