/** @vitest-environment jsdom */
/**
 * `useGuardedDelete` — the refusal actually reaching the operator.
 *
 * The back office guards deletes on the server and each refusal names what is in the way. Those
 * arrive as Inertia `errors`, which pages render under a form field — and a delete has no form
 * field, so before this the refusal went nowhere: the page reloaded, the record stayed, and nothing
 * was said. Tested because it is the only thing standing between a correct guard and a screen that
 * looks broken.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const del = vi.fn();
const show = vi.fn();

vi.mock('@inertiajs/react', () => ({ router: { delete: (...args: unknown[]) => del(...args) } }));
vi.mock('@shared/ui', () => ({ useToast: () => ({ show, dismiss: vi.fn(), clear: vi.fn() }) }));

const { useGuardedDelete } = await import('./guardedRequest');

function Harness(): JSX.Element {
    const remove = useGuardedDelete();

    return (
        <button type="button" onClick={() => remove('/taxes/7')}>
            delete
        </button>
    );
}

/** The `onError` callback Inertia would invoke, pulled off the options the hook passed. */
function onErrorOf(): (errors: Record<string, string>) => void {
    const options = del.mock.calls[0]?.[1] as { onError?: (e: Record<string, string>) => void };
    const handler = options?.onError;

    expect(handler, 'the hook must register an onError handler').toBeTypeOf('function');

    return handler as (errors: Record<string, string>) => void;
}

describe('useGuardedDelete', () => {
    beforeEach(() => {
        del.mockClear();
        show.mockClear();
    });

    it('issues the delete against the given url', async () => {
        render(<Harness />);
        await userEvent.click(screen.getByRole('button'));

        expect(del).toHaveBeenCalledTimes(1);
        expect(del.mock.calls[0]?.[0]).toBe('/taxes/7');
    });

    it("shows the server's own refusal, because only it knows what is in the way", async () => {
        render(<Harness />);
        await userEvent.click(screen.getByRole('button'));

        onErrorOf()({ tax: '2 open order(s) still carry this tax.' });

        expect(show).toHaveBeenCalledTimes(1);
        expect(show.mock.calls[0]?.[0]).toMatchObject({
            tone: 'danger',
            title: '2 open order(s) still carry this tax.',
        });
    });

    it('finds the message whatever key the server used', async () => {
        // Every guard picks its own key — `tax`, `group`, `method`, `display`, `stages`. The toast
        // must not depend on guessing which.
        render(<Harness />);
        await userEvent.click(screen.getByRole('button'));

        onErrorOf()({ group: 'This group still holds 3 tax(es).' });

        expect(show.mock.calls[0]?.[0]).toMatchObject({ title: 'This group still holds 3 tax(es).' });
    });

    it('stays quiet when there is nothing to say', async () => {
        // An empty error bag is not a refusal to report — a toast reading "" is worse than silence.
        render(<Harness />);
        await userEvent.click(screen.getByRole('button'));

        onErrorOf()({});
        onErrorOf()({ tax: '   ' });

        expect(show).not.toHaveBeenCalled();
    });

    it('leaves the scroll position alone, since the row is where the operator is looking', async () => {
        render(<Harness />);
        await userEvent.click(screen.getByRole('button'));

        expect(del.mock.calls[0]?.[1]).toMatchObject({ preserveScroll: true });
    });
});
