import { Decimal } from '@domain/money/decimal';
import { Button, NumPad, cn } from '@shared/ui';
import { useCan } from '@shared/auth';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { requestApproval } from '../domain/approval';
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
 *  - **A right the cashier lacks is a question, not a wall** (REG-045, BAN-518). Price editing and
 *    an over-limit discount used to be a disabled button with a `title` explaining why — invisible
 *    on the tablet this actually runs on, so it read as the till ignoring the tap. Now it asks for a
 *    manager, and the approval is recorded against **that line**: the manager who unlocks the wine
 *    has not unlocked the rest of the order (BAN-515).
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

    const grantLineApproval = useUiStore((state) => state.grantLineApproval);
    // Subscribed to rather than read through the store's own getter, so the panel re-renders the
    // moment a grant lands. A `get()`-based helper would answer correctly and never repaint.
    const lineApprovals = useUiStore((state) => state.lineApprovals);
    const [refused, setRefused] = useState<string | null>(null);

    const approvedHere = useCallback(
        (ability: string): boolean => line !== null && (lineApprovals[line.uuid]?.includes(ability) ?? false),
        [line, lineApprovals],
    );

    // The pusher's own right, or a manager's approval standing on *this* line.
    const allowPrice =
        can('line.price_override') ||
        catalog.config?.restrict_price_control !== true ||
        approvedHere('line.price_override');
    const allowDiscount = can('line.discount') && catalog.config?.manual_discount !== false;

    // The house cap. Anything above it is a manager's call — the server enforces it either way, so
    // knowing the number here is only about asking before the sale rather than after it.
    const discountLimit = catalog.config?.discount_limit_percent ?? '100';
    const mayDiscountAbove = can('line.discount.above_limit') || approvedHere('line.discount.above_limit');

    // Quantity already handed to the kitchen for this exact line+note (REG-107).
    const order = useOrder(line?.order_uuid ?? null);
    const alreadySent = line ? (order?.last_prep_snapshot?.lines[prepKeyOf(line)] ?? 0) : 0;

    // REG-077, XCT-058 — read off the line itself rather than asked of `order-actions`, so the
    // panel repaints when the selection moves. `setQuantity` refuses one of these regardless; this
    // is only about the cashier being told, instead of tapping a number into a void.
    const weighed = line !== null && line.weight_source !== null;

    // A refusal is about the line it was raised on. Leaving it up after the cashier selects another
    // one tells them a lie about the line they are now looking at.
    const selectedUuid = line?.uuid ?? null;
    useEffect(() => {
        setRefused(null);
    }, [selectedUuid]);

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
                if (!allowDiscount) return;

                const asked = value === '' ? '0' : value;

                // Clamped rather than refused, and the ask is offered beside it. Refusing outright
                // would leave the cashier retyping a number the till will never accept; applying it
                // would be a lie the server corrects after the sale.
                if (!mayDiscountAbove && Decimal.of(asked).gt(Decimal.of(discountLimit))) {
                    setDiscount(line.uuid, discountLimit);
                    setRefused('line.discount.above_limit');

                    return;
                }

                setRefused(null);
                setDiscount(line.uuid, asked);

                return;
            }
            // REG-077 — a weighed quantity is a measurement and the numpad is not an instrument.
            // Checked before `alreadySent`, because a weighed line the kitchen has already seen was
            // refused twice over and would have shown nothing either way.
            if (weighed) {
                setRefused('line.weighed');
                return;
            }
            // A line the kitchen has seen is committed on confirm, so the compensating negative
            // line is created once rather than once per digit.
            if (alreadySent > 0) return;
            setQuantity(line.uuid, parsed);
        },
        [allowDiscount, allowPrice, alreadySent, line, mode, weighed],
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

    /**
     * Ask a manager to unlock one ability on one line (REG-045).
     *
     * The approval is recorded against `line.uuid`, so it authorises this line and nothing else —
     * the server enforces that on ingest (BAN-515) and would refuse a second line claiming the same
     * grant. Nothing is applied on a refusal or a cancel: the line stays exactly as it was.
     */
    const askManager = useCallback(
        async (ability: string, then?: () => void) => {
            if (!line) return;

            // Both, and the order is the load-bearing one: without it `persistence.ts` never finds
            // the row, so the manager's approval stays on this device and the server reprices the
            // line as though nobody had authorised it.
            const granted = await requestApproval(ability, { lineUuid: line.uuid, orderUuid: line.order_uuid });

            if (granted === null) return;

            grantLineApproval(line.uuid, ability);
            setRefused(null);
            then?.();
        },
        [grantLineApproval, line],
    );

    const onConfirm = useCallback(
        (value: string) => {
            if (!line) return;
            if (mode === 'quantity') {
                if (weighed) {
                    setRefused('line.weighed');
                    previous.current = '';
                    setBuffer('');
                    return;
                }
                const parsed = value === '' ? line.quantity : Number.parseFloat(value);
                if (Number.isFinite(parsed)) reduceQuantity(line.uuid, parsed);
            }
            previous.current = '';
            setBuffer('');
        },
        [line, mode, setBuffer, weighed],
    );

    return (
        <div className={cn('flex flex-col gap-2', className)} data-testid="numpad">
            <div className="flex gap-2">
                {MODE_KEYS.map((key) => {
                    // Price is *askable*: the cashier taps it, a manager unlocks it for this line.
                    // Discount is a role the register grants or does not, with nobody to ask.
                    const askable = key.mode === 'price' && !allowPrice && line !== null;
                    const disabled = key.mode === 'discount' && !allowDiscount;

                    return (
                        <Button
                            key={key.mode}
                            size="md"
                            variant={mode === key.mode ? 'primary' : 'secondary'}
                            disabled={disabled}
                            title={disabled ? t('reg.order.noDiscountRight') : undefined}
                            className="flex-1"
                            data-testid={`numpad-mode-${key.mode}`}
                            onClick={() =>
                                askable
                                    ? void askManager('line.price_override', () => setMode(key.mode))
                                    : setMode(key.mode)
                            }
                        >
                            {t(key.labelKey)}
                            {askable ? ' 🔒' : ''}
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

            {refused === 'line.discount.above_limit' ? (
                <div className="rounded-pos bg-warning-soft p-3 text-sm" data-testid="discount-over-limit">
                    <p>{t('reg.order.discountCapped', { limit: discountLimit })}</p>
                    <Button
                        size="sm"
                        variant="secondary"
                        className="mt-2"
                        data-testid="ask-manager-discount"
                        onClick={() =>
                            void askManager('line.discount.above_limit', () => {
                                if (line && buffer !== '') setDiscount(line.uuid, buffer);
                            })
                        }
                    >
                        {t('reg.order.askManager')}
                    </Button>
                </div>
            ) : null}

            {refused === 'line.weighed' ? (
                <div className="rounded-pos bg-warning-soft p-3 text-sm" data-testid="line-weighed-refused">
                    <p>{t('reg.order.weighedLocked')}</p>
                </div>
            ) : null}

            {line === null ? (
                <p className="text-center text-sm text-slate-500">{t('reg.order.selectLine')}</p>
            ) : null}
        </div>
    );
}
