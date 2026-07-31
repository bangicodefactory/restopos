import { Decimal } from '@domain/money/decimal';
import type { CurrencyFormat } from '@domain/receipt/index';
import { formatMoney } from '@domain/receipt/index';
import { forwardRef, useCallback, useMemo, type InputHTMLAttributes, type JSX } from 'react';

import { FOCUS_RING, cn } from './cn';

/**
 * Money input.
 *
 * The contract that matters: **`value` and `onChange` are decimal strings, never numbers.** A
 * monetary value that will be persisted or compared never becomes a JS float on its way through the
 * UI (docs/CONVENTIONS.md). The component parses with `Decimal`, so `12,30` typed on a French
 * keyboard and `12.30` typed on an English one are the same amount, and an unparseable
 * intermediate state (`12.`) is preserved verbatim while the user is still typing.
 */

export type MoneyInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'> & {
    value: string;
    onChange: (value: string) => void;
    currency: CurrencyFormat;
    label?: string;
    invalid?: boolean;
    /** Render the formatted amount under the field ("= 1 234,50 €"). */
    showPreview?: boolean;
    size?: 'md' | 'lg' | 'xl';
};

const SIZES = {
    md: 'min-h-touch text-lg',
    lg: 'min-h-touch-lg text-2xl',
    xl: 'min-h-touch-xl text-3xl',
} as const;

/** Accept both separators, strip grouping, keep a single leading minus. */
export function sanitizeMoneyInput(raw: string, decimals: number): string {
    const normalized = raw.replace(/\s|\u00a0/g, '').replace(',', '.');
    const negative = normalized.startsWith('-');
    const digits = normalized.replace(/[^\d.]/g, '');

    const firstDot = digits.indexOf('.');
    const cleaned =
        firstDot === -1
            ? digits
            : digits.slice(0, firstDot + 1) + digits.slice(firstDot + 1).replace(/\./g, '');

    const limited =
        firstDot === -1 || decimals === 0
            ? cleaned.split('.')[0] ?? ''
            : cleaned.slice(0, firstDot + 1 + decimals);

    return (negative ? '-' : '') + limited;
}

export function isValidMoney(value: string): boolean {
    if (value === '' || value === '-') return false;
    try {
        Decimal.of(value.endsWith('.') ? value.slice(0, -1) : value);
        return true;
    } catch {
        return false;
    }
}

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
    { value, onChange, currency, label, invalid, showPreview = false, size = 'lg', className, ...rest },
    ref,
): JSX.Element {
    const handleChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            onChange(sanitizeMoneyInput(event.target.value, currency.decimalPlaces));
        },
        [currency.decimalPlaces, onChange],
    );

    const preview = useMemo(() => {
        if (!showPreview || !isValidMoney(value)) return null;
        return formatMoney(value.endsWith('.') ? value.slice(0, -1) : value, currency);
    }, [currency, showPreview, value]);

    const bad = invalid === true || (value !== '' && !isValidMoney(value) && !value.endsWith('.'));

    return (
        <label className="flex flex-col gap-1">
            {label ? <span className="text-sm font-medium text-slate-700">{label}</span> : null}
            <div className="relative flex items-center">
                {currency.position === 'before' ? (
                    <span className="pointer-events-none absolute start-3 text-slate-500">{currency.symbol}</span>
                ) : null}
                <input
                    ref={ref}
                    // `inputMode="decimal"` gets the numeric OS keyboard without blocking our own.
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    onChange={handleChange}
                    aria-invalid={bad || undefined}
                    className={cn(
                        'w-full rounded-pos bg-white text-end font-semibold tabular-nums ring-1 ring-inset',
                        currency.position === 'before' ? 'ps-10 pe-3' : 'ps-3 pe-10',
                        bad ? 'ring-danger' : 'ring-slate-300',
                        SIZES[size],
                        FOCUS_RING,
                        className,
                    )}
                    {...rest}
                />
                {currency.position === 'after' ? (
                    <span className="pointer-events-none absolute end-3 text-slate-500">{currency.symbol}</span>
                ) : null}
            </div>
            {preview ? <span className="text-end text-sm text-slate-500 tabular-nums">= {preview}</span> : null}
        </label>
    );
});

/** Read-only money display — right-aligned, tabular, never re-formatted by the browser. */
export function Money({
    amount,
    currency,
    className,
    withSymbol = true,
}: {
    amount: string;
    currency: CurrencyFormat;
    className?: string;
    withSymbol?: boolean;
}): JSX.Element {
    return (
        <span className={cn('tabular-nums', className)}>{formatMoney(amount, currency, withSymbol)}</span>
    );
}
