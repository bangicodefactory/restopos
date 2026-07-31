import { Button, NumPad, cn } from '@shared/ui';
import { useCan } from '@shared/auth';
import type { JSX } from 'react';
import { useCallback, useRef } from 'react';

import { useT } from '../i18n';
import { useCatalog, useOrder, useSelectedLine } from '../hooks/use-register';
import {
    prepKeyOf,
    reduceQuantity,
    removeLine,
    setDiscount,
    setPriceUnit,
    setQuantity,
} from '../domain/order-actions';
import { useUiStore, type NumpadMode } from '../state/ui-store';

/**
 * The numpad (REG-103 … REG-105).
 *
 * The micro-behaviours here are what cashiers actually feel, so they are reproduced deliberately:
 *
 *  - **Backspace on an empty buffer removes the line.** It is the fastest way to undo a mis-tap and
 *    every experienced user reaches for it.
 *  - **Digits are held for the scanner-guard interval** (`@shared/ui`'s `NumPad` does this): a scan
 *    is thirteen keystrokes in fifteen milliseconds, and without the guard it becomes a quantity of
 *    five trillion.
 *  - **Quantity is applied live, except on a line the kitchen already has.** There, the change is
 *    committed on confirm so REG-107's compensating negative line is created once, not per digit.
 *  - **Price mode falls back to quantity for non-managers** (REG-182) rather than showing a control
 *    that then refuses to work.
 */

const MODE_KEYS: Array<{ mode: NumpadMode; labelKey: 'reg.order.qty' | 'reg.order.price' | 'reg.order.discount' }> = [
    { mode: 'quantity', labelKey: 'reg.order.qty' },
    { mode: 'price', labelKey: 'reg.order.price' },
    { mode: 'discount', labelKey: 'reg.order.discount' },
];

export function NumpadPanel({ className }: { className?: string }): JSX.Element {
    const t = useT();
    const can = useCan();
    const catalog = useCatalog();
    const line = useSelectedLine();
    const buffer = useUiStore((state) => state.buffer);
    const mode = useUiStore((state) => state.numpadMode);
    const setBuffer = useUiStore((state) => state.setBuffer);
    const setMode = useUiStore((state) => state.setNumpadMode);

    const previous = useRef('');

    const allowPrice = can('line.price_override') || catalog.config?.restrict_price_control !== true;
    const allowDiscount = can('line.discount') && catalog.config?.manual_discount !== false;

    // Quantity already handed to the kitchen for this exact line+note (REG-107).
    const order = useOrder(line?.order_uuid ?? null);
    const alreadySent = line ? (order?.last_prep_snapshot?.lines[prepKeyOf(line)] ?? 0) : 0;

    const applyLive = useCallback(
        (value: string) => {
            if (!line) return;
            const parsed = value === '' || value === '-' ? 0 : Number.parseFloat(value);
            if (!Number.isFinite(parsed)) return;

            if (mode === 'price') {
                if (allowPrice) setPriceUnit(line.uuid, value === '' ? '0' : value);
                return;
            }
            if (mode === 'discount') {
                if (allowDiscount) setDiscount(line.uuid, value === '' ? '0' : value);
                return;
            }
            // A line the kitchen has seen is committed on confirm, so the compensating negative
            // line is created once rather than once per digit.
            if (alreadySent > 0) return;
            setQuantity(line.uuid, parsed);
        },
        [allowDiscount, allowPrice, alreadySent, line, mode],
    );

    const onChange = useCallback(
        (next: string) => {
            // Backspace on an empty buffer means "remove the selected line".
            if (next === '' && previous.current === '' && line) {
                removeLine(line.uuid);
                previous.current = '';
                setBuffer('');
                return;
            }
            previous.current = next;
            setBuffer(next);
            applyLive(next);
        },
        [applyLive, line, setBuffer],
    );

    const onConfirm = useCallback(
        (value: string) => {
            if (!line) return;
            if (mode === 'quantity') {
                const parsed = value === '' ? line.quantity : Number.parseFloat(value);
                if (Number.isFinite(parsed)) reduceQuantity(line.uuid, parsed);
            }
            previous.current = '';
            setBuffer('');
        },
        [line, mode, setBuffer],
    );

    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <div className="flex gap-2">
                {MODE_KEYS.map((key) => {
                    const disabled =
                        (key.mode === 'price' && !allowPrice) || (key.mode === 'discount' && !allowDiscount);
                    return (
                        <Button
                            key={key.mode}
                            size="md"
                            variant={mode === key.mode ? 'primary' : 'secondary'}
                            disabled={disabled}
                            title={
                                disabled
                                    ? key.mode === 'price'
                                        ? t('reg.order.noPriceRight')
                                        : t('reg.order.noDiscountRight')
                                    : undefined
                            }
                            className="flex-1"
                            onClick={() => setMode(key.mode)}
                        >
                            {t(key.labelKey)}
                        </Button>
                    );
                })}
            </div>

            <div
                aria-live="polite"
                className="rounded-pos bg-slate-900 px-3 py-2 text-right font-mono text-2xl text-white"
            >
                {buffer === '' ? '·' : buffer}
            </div>

            <NumPad
                value={buffer}
                onChange={onChange}
                onConfirm={onConfirm}
                mode={mode}
                allowNegative={mode === 'quantity'}
                disabled={line === null}
                confirmLabel={t('common.ok')}
            />

            {line === null ? (
                <p className="text-center text-sm text-slate-500">{t('reg.order.selectLine')}</p>
            ) : null}
        </div>
    );
}
