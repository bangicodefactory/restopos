/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NumPad } from './NumPad';

/**
 * BAN-505 — every key the pad renders must carry its hook.
 *
 * The bug this exists to prevent: only the `KEYS` loop carried `data-key`, so the `0` — laid out
 * separately from the 1–9 grid — had none, and `typePin` in the E2E harness silently matched nothing
 * for any PIN containing a zero. Every seeded PIN happens to avoid zero, so the whole suite stayed
 * green while the helper was broken.
 *
 * That is the same shape as the precache contract in BAN-504: two lists that have to agree, with no
 * test asserting they do. This is that test.
 */
describe('NumPad hooks', () => {
    it('gives every rendered key a data-key', () => {
        render(<NumPad value="" onChange={() => {}} onConfirm={() => {}} />);

        const keys = screen.getAllByTestId('numpad-key');

        expect(keys.length).toBeGreaterThan(0);

        for (const key of keys) {
            expect(key.getAttribute('data-key')).toBeTruthy();
        }
    });

    it('exposes every digit, zero included', () => {
        render(<NumPad value="" onChange={() => {}} onConfirm={() => {}} />);

        const values = screen.getAllByTestId('numpad-key').map((key) => key.getAttribute('data-key'));

        for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
            expect(values).toContain(digit);
        }
    });

    it('exposes the editing keys a spec needs to correct a mistyped entry', () => {
        render(<NumPad value="12" onChange={() => {}} onConfirm={() => {}} />);

        const values = screen.getAllByTestId('numpad-key').map((key) => key.getAttribute('data-key'));

        expect(values).toContain('⌫');
        expect(values).toContain('C');
    });

    it('exposes the decimal point, and the sign key when negatives are allowed', () => {
        const { unmount } = render(<NumPad value="" onChange={() => {}} onConfirm={() => {}} />);

        expect(screen.getAllByTestId('numpad-key').map((k) => k.getAttribute('data-key'))).toContain('.');

        unmount();

        render(<NumPad value="" onChange={() => {}} onConfirm={() => {}} allowNegative />);

        const values = screen.getAllByTestId('numpad-key').map((k) => k.getAttribute('data-key'));

        expect(values).toContain('±');
        expect(values).toContain('.');
    });

    it('marks the confirm button, whatever its label says', () => {
        // "Ouvrir la caisse" on login, "Déverrouiller" on the lock screen, "OK" elsewhere.
        render(<NumPad value="" onChange={() => {}} onConfirm={() => {}} confirmLabel="Déverrouiller" />);

        expect(screen.getByTestId('numpad-confirm')).toHaveTextContent('Déverrouiller');
    });

    it('still presses the key it is labelled with', async () => {
        // The hooks are only worth having if they address the button that does the thing — a
        // `data-key` on the wrong button would be worse than none.
        const onChange = vi.fn();

        render(<NumPad value="" onChange={onChange} onConfirm={() => {}} scannerGuardMs={0} />);

        const zero = screen
            .getAllByTestId('numpad-key')
            .find((key) => key.getAttribute('data-key') === '0');

        await userEvent.click(zero as HTMLElement);

        expect(onChange).toHaveBeenCalledWith('0');
    });
});
