import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import { Button } from './Button';
import { cn } from './cn';

/**
 * The number buffer and its keypad — the single most-used control in the whole product.
 *
 * Two behaviours copied deliberately from Odoo because they are correct:
 *
 *  1. **The buffer is a string, not a number.** `1.` and `1.0` are different intermediate states a
 *     cashier can see and back out of; parsing to a float on every keystroke destroys that.
 *  2. **Digits are delayed by the scanner interval.** A scan of `5901234123457` arrives as thirteen
 *     keystrokes in ~15 ms. Without the delay it becomes a quantity of 5 901 234 123 457 before the
 *     scanner has finished. `scannerGuardMs` holds each digit briefly; a burst is discarded by the
 *     scanner handler instead.
 */

export type NumPadMode = 'quantity' | 'price' | 'discount' | 'plain';

export type NumPadProps = {
    value: string;
    onChange: (next: string) => void;
    /** Confirm (the big green key). Omit to hide it. */
    onConfirm?: (value: string) => void;
    mode?: NumPadMode;
    /** Show the +/- sign key (refunds, cash-out). */
    allowNegative?: boolean;
    decimals?: number;
    className?: string;
    /** Extra keys rendered in a fourth column (e.g. "Qty / Price / Disc" mode switches). */
    sideKeys?: JSX.Element;
    disabled?: boolean;
    /** Milliseconds a digit waits before being committed; 0 disables the scanner guard. */
    scannerGuardMs?: number;
    confirmLabel?: string;
};

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'] as const;

export function appendDigit(buffer: string, key: string, decimals: number): string {
    if (key === '.') {
        if (decimals === 0 || buffer.includes('.')) return buffer;
        return buffer === '' ? '0.' : `${buffer}.`;
    }
    if (key === '±') {
        return buffer.startsWith('-') ? buffer.slice(1) : `-${buffer}`;
    }
    const dot = buffer.indexOf('.');
    if (dot >= 0 && buffer.length - dot - 1 >= decimals) return buffer;
    if (buffer === '0') return key;
    if (buffer === '-0') return `-${key}`;
    return buffer + key;
}

export function backspace(buffer: string): string {
    if (buffer.length <= 1) return '';
    return buffer.slice(0, -1);
}

export function NumPad({
    value,
    onChange,
    onConfirm,
    mode = 'plain',
    allowNegative = false,
    decimals,
    className,
    sideKeys,
    disabled = false,
    scannerGuardMs = 30,
    confirmLabel = 'OK',
}: NumPadProps): JSX.Element {
    const places = decimals ?? (mode === 'quantity' ? 3 : mode === 'discount' ? 2 : 2);
    const pending = useRef<{ timer: ReturnType<typeof setTimeout>; keys: string } | null>(null);
    const valueRef = useRef(value);
    valueRef.current = value;

    const commit = useCallback(
        (keys: string) => {
            let next = valueRef.current;
            for (const key of keys) next = appendDigit(next, key, places);
            onChange(next);
        },
        [onChange, places],
    );

    const press = useCallback(
        (key: string) => {
            if (disabled) return;

            if (key === 'C') {
                if (pending.current) clearTimeout(pending.current.timer);
                pending.current = null;
                onChange('');
                return;
            }
            if (key === '⌫') {
                if (pending.current) clearTimeout(pending.current.timer);
                pending.current = null;
                onChange(backspace(valueRef.current));
                return;
            }

            if (scannerGuardMs <= 0) {
                commit(key);
                return;
            }

            // Coalesce a burst: if a second digit arrives inside the guard window it is almost
            // certainly a scanner, and the scan handler will claim it.
            const keys = (pending.current?.keys ?? '') + key;
            if (pending.current) clearTimeout(pending.current.timer);
            pending.current = {
                keys,
                timer: setTimeout(() => {
                    const buffered = pending.current?.keys ?? '';
                    pending.current = null;
                    commit(buffered);
                }, scannerGuardMs),
            };
        },
        [commit, disabled, onChange, scannerGuardMs],
    );

    useEffect(
        () => () => {
            if (pending.current) clearTimeout(pending.current.timer);
        },
        [],
    );

    return (
        <div className={cn('grid gap-2', sideKeys ? 'grid-cols-4' : 'grid-cols-3', className)}>
            {KEYS.map((key) => (
                <Button
                    key={key}
                    size="xl"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => press(key)}
                    // Addressed by value rather than by visible text: a spec typing a PIN should not
                    // depend on the glyph, and `getByRole('button', { name: '1' })` also matches a
                    // table numbered 1 elsewhere on screen (BAN-505).
                    data-testid="numpad-key"
                    data-key={key}
                >
                    {key}
                </Button>
            ))}

            {allowNegative ? (
                <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('±')}>
                    +/−
                </Button>
            ) : (
                <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('.')}>
                    .
                </Button>
            )}

            <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('0')}>
                0
            </Button>

            {allowNegative ? (
                <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('.')}>
                    .
                </Button>
            ) : (
                <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('⌫')} aria-label="Backspace">
                    ⌫
                </Button>
            )}

            {sideKeys ? <div className="row-span-4 grid gap-2">{sideKeys}</div> : null}

            <Button size="xl" variant="ghost" disabled={disabled} onClick={() => press('C')} className="col-span-1">
                C
            </Button>

            {onConfirm ? (
                <Button
                    size="xl"
                    variant="success"
                    disabled={disabled}
                    className="col-span-2"
                    onClick={() => onConfirm(valueRef.current)}
                    // The label varies by caller — "Ouvrir la caisse" on login, "Déverrouiller" on
                    // the lock screen, "OK" elsewhere — so the hook is what a spec addresses.
                    data-testid="numpad-confirm"
                >
                    {confirmLabel}
                </Button>
            ) : (
                <Button size="xl" variant="secondary" disabled={disabled} onClick={() => press('⌫')} className="col-span-2">
                    ⌫
                </Button>
            )}
        </div>
    );
}

/** Controlled buffer with the parsing rules the register needs. */
export function useNumberBuffer(initial = ''): {
    value: string;
    setValue: (next: string) => void;
    asNumber: number;
    reset: () => void;
} {
    const [value, setValue] = useState(initial);
    const parsed = value === '' || value === '-' ? 0 : Number.parseFloat(value);
    return {
        value,
        setValue,
        asNumber: Number.isFinite(parsed) ? parsed : 0,
        reset: () => setValue(''),
    };
}
