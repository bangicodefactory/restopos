/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { installCatalog, makeConfig, resetRegisterState } from '../domain/__fixtures__/catalog';
import { clearRuntime, setRuntime } from '../data/runtime';
import { usePosSessionStore } from '../state/session-store';
import { SessionScreen } from './SessionScreen';

/**
 * BAN-417 — a register refused for its configuration must be able to ask again.
 *
 * This pane is a **terminal** screen: with no session there is nowhere else in the app to navigate,
 * and the problems are read once on mount. Disabling the open button without a way to re-check
 * turns "your register has no payment method" into a till that is simply broken — the manager fixes
 * the configuration in the back office and the screen goes on refusing, with no route back short of
 * reloading the browser.
 */

/** A `sessions/current` that answers with `problems` first and a clean register afterwards. */
function runtime(responses: Array<{ problems: Array<{ code: string; message: string }> }>) {
    const get = vi.fn();

    for (const response of responses) {
        get.mockResolvedValueOnce({
            data: { session: null, opening: { expected_float: '0.0000', problems: response.problems } },
        });
    }

    setRuntime({ api: { get }, db: { sessions: { toArray: () => Promise.resolve([]) } } } as never);

    return get;
}

const NO_METHOD = { code: 'no_payment_method', message: 'This register has no payment method.' };

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    usePosSessionStore.setState((state) => ({ ...state, session: null, opening: null, error: null }));
    installCatalog({ config: makeConfig() });
});

it('names the problem and refuses to open on it', async () => {
    runtime([{ problems: [NO_METHOD] }]);

    render(<SessionScreen mode="open" onDone={vi.fn()} />);

    expect(await screen.findByText(NO_METHOD.message)).toBeTruthy();
    await waitFor(() =>
        expect(screen.getByRole('button', { name: /open session/i }).hasAttribute('disabled')).toBe(true),
    );
});

it('re-asks the server when the configuration is fixed, without a reload', async () => {
    const get = runtime([{ problems: [NO_METHOD] }, { problems: [] }]);

    render(<SessionScreen mode="open" onDone={vi.fn()} />);

    await screen.findByText(NO_METHOD.message);
    expect(get).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    // The problem is gone and the register can open — the manager's fix took effect on this screen.
    await waitFor(() => expect(screen.queryByText(NO_METHOD.message)).toBeNull());
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /open session/i }).hasAttribute('disabled')).toBe(false);
});

it('leaves the open button alone on a register with nothing wrong', async () => {
    runtime([{ problems: [] }]);

    render(<SessionScreen mode="open" onDone={vi.fn()} />);

    await waitFor(() =>
        expect(screen.getByRole('button', { name: /open session/i }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
});
