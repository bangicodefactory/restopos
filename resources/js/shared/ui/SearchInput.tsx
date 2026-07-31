import { forwardRef, useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type JSX } from 'react';

import { FOCUS_RING, cn } from './cn';

/**
 * Search field.
 *
 * Two POS-specific behaviours:
 *
 *  1. **Scanner passthrough.** A keyboard-wedge scanner types into whatever is focused, which at a
 *     till is usually this box. A burst that ends in Enter is reported through `onScan` instead of
 *     `onChange`, so scanning a product while the search box has focus adds the product rather than
 *     searching for its barcode.
 *  2. **Debounced value, immediate display.** The visible text updates on every keystroke; the
 *     debounced value drives the (potentially 5 000-row) filter.
 */

export type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: string;
    onChange: (value: string) => void;
    /** Fired when a scanner burst is detected (fast keystrokes terminated by Enter). */
    onScan?: (code: string) => void;
    onClear?: () => void;
    debounceMs?: number;
    /** Max ms between keystrokes for a burst to count as a scan. */
    scanIntervalMs?: number;
    minScanLength?: number;
};

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
    {
        value,
        onChange,
        onScan,
        onClear,
        debounceMs = 120,
        scanIntervalMs = 30,
        minScanLength = 4,
        className,
        placeholder = 'Search…',
        ...rest
    },
    ref,
): JSX.Element {
    const [text, setText] = useState(value);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scanBuffer = useRef('');
    const lastKeyAt = useRef(0);

    useEffect(() => setText(value), [value]);

    useEffect(
        () => () => {
            if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
    );

    const push = useCallback(
        (next: string) => {
            setText(next);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => onChange(next), debounceMs);
        },
        [debounceMs, onChange],
    );

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (!onScan) return;

            const now = performance.now();
            if (now - lastKeyAt.current > scanIntervalMs) scanBuffer.current = '';
            lastKeyAt.current = now;

            if (event.key === 'Enter') {
                const code = scanBuffer.current;
                scanBuffer.current = '';
                if (code.length >= minScanLength) {
                    event.preventDefault();
                    event.stopPropagation();
                    setText('');
                    onChange('');
                    onScan(code);
                }
                return;
            }

            if (event.key.length === 1) scanBuffer.current += event.key;
        },
        [minScanLength, onChange, onScan, scanIntervalMs],
    );

    return (
        <div className={cn('relative flex items-center', className)}>
            <span className="pointer-events-none absolute start-3 text-slate-400" aria-hidden>
                ⌕
            </span>
            <input
                ref={ref}
                type="search"
                role="searchbox"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={text}
                placeholder={placeholder}
                onChange={(event) => push(event.target.value)}
                onKeyDown={onKeyDown}
                className={cn(
                    'min-h-touch-lg w-full rounded-pos bg-white ps-9 pe-10 text-base ring-1 ring-inset ring-slate-300',
                    '[&::-webkit-search-cancel-button]:hidden',
                    FOCUS_RING,
                )}
                {...rest}
            />
            {text !== '' ? (
                <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute end-1 min-h-touch min-w-touch rounded-pos text-slate-400 hover:text-slate-700"
                    onClick={() => {
                        setText('');
                        onChange('');
                        onClear?.();
                    }}
                >
                    ✕
                </button>
            ) : null}
        </div>
    );
});
