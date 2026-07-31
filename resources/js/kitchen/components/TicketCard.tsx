import { cn } from '@shared/ui';
import type { JSX, ReactNode } from 'react';

import { useT } from '../i18n';
import {
    effectiveStageId,
    groupLinesByCourse,
    isCardComplete,
    isLineCancelled,
    isLineChanged,
    isLineDone,
    stageById,
} from '../logic/board';
import { elapsedSeconds, isFlashingNew, thresholdsFor, urgencyOf } from '../logic/elapsed';
import type { KitchenDisplay, KitchenLine, KitchenOrder, KitchenStage } from '../types';
import { ElapsedBadge, urgencyRing } from './ElapsedBadge';
import { useLongPress } from './hooks';

/**
 * One order card (KDS-005, KDS-006, KDS-007, KDS-010, KDS-016, KDS-017, KDS-018).
 *
 * Legibility rules this component enforces, all of them from "readable from three metres":
 *   - nothing below `text-base` (17 px at our scale), product names at `text-xl`;
 *   - quantity is the loudest element on a row, because "2×" mis-read as "1×" is a remake;
 *   - notes are boxed and coloured, never italic grey — they are the #1 source of kitchen errors;
 *   - a cancelled line is struck through *and* framed in red and stays on the card, because
 *     something already on the grill has to be pulled off it.
 *
 * Interaction: tap the card to advance a stage, hold it to recall. Tap a row to tick that item off.
 * Every target is ≥ 64 px tall.
 */

export type TicketCardProps = {
    order: KitchenOrder;
    stages: readonly KitchenStage[];
    display: KitchenDisplay;
    now: number;
    firstSeenAt: number | undefined;
    onAdvance: (orderId: number) => void;
    onRecall: (orderId: number) => void;
    onComplete: (orderId: number) => void;
    onToggleLine: (orderId: number, lineId: number) => void;
    /** Compact mode for the recall bar. */
    variant?: 'board' | 'recall';
};

export function TicketCard({
    order,
    stages,
    display,
    now,
    firstSeenAt,
    onAdvance,
    onRecall,
    onComplete,
    onToggleLine,
    variant = 'board',
}: TicketCardProps): JSX.Element {
    const t = useT();
    const stage = stageById(stages, effectiveStageId(order, stages));
    const thresholds = thresholdsFor(display, stage);
    const seconds = elapsedSeconds(order, now);
    const level = urgencyOf(seconds, thresholds);
    const flashing = isFlashingNew(firstSeenAt, now);
    const complete = isCardComplete(order);
    const courses = groupLinesByCourse(order.lines);

    const press = useLongPress(
        () => (variant === 'recall' ? onRecall(order.id) : onAdvance(order.id)),
        variant === 'recall' ? null : () => onRecall(order.id),
    );

    return (
        <article
            className={cn(
                'flex flex-col overflow-hidden rounded-pos-lg bg-kitchen-surface text-kitchen-text shadow-pos-lg',
                'touch-manipulation select-none',
                urgencyRing(level),
                flashing && 'animate-pulse-sync ring-4 ring-kitchen-new',
                variant === 'recall' && 'opacity-80',
            )}
            aria-label={`${order.tracking_number ?? order.uuid} — ${stage?.name ?? ''}`}
        >
            <header
                {...press}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (variant === 'recall') onRecall(order.id);
                    else onAdvance(order.id);
                }}
                className={cn(
                    'flex min-h-touch-xl cursor-pointer items-center gap-3 px-4 py-3',
                    'bg-kitchen-raised active:brightness-125',
                    stage?.color ? '' : 'border-b border-kitchen-border',
                )}
                style={stage?.color ? { borderBottom: `4px solid ${stage.color}` } : undefined}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span className="truncate text-3xl font-black leading-none tabular-nums">
                            {order.tracking_number ?? `#${order.id}`}
                        </span>
                        {order.is_recalled && (
                            <span className="rounded bg-kitchen-late px-2 py-0.5 text-base font-bold text-white">
                                {t('kds.board.recalled')}
                            </span>
                        )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-base font-semibold text-kitchen-muted">
                        <Badge tone={order.table_label ? 'table' : 'takeaway'}>
                            {order.table_label ?? order.preset_label ?? t('kds.board.takeaway')}
                        </Badge>
                        {typeof order.guest_count === 'number' && order.guest_count > 0 && (
                            <Badge tone="muted">
                                {order.guest_count === 1
                                    ? t('kds.board.guestsOne')
                                    : t('kds.board.guests', { count: order.guest_count })}
                            </Badge>
                        )}
                        {order.customer_name && <Badge tone="muted">{order.customer_name}</Badge>}
                    </div>
                </div>
                <ElapsedBadge seconds={seconds} thresholds={thresholds} size="lg" />
            </header>

            {order.order_note && (
                <p className="mx-3 mt-3 rounded-pos bg-kitchen-cooking/20 px-3 py-2 text-lg font-bold text-kitchen-cooking ring-1 ring-inset ring-kitchen-cooking/50">
                    <span className="me-2 text-base uppercase tracking-wide opacity-80">
                        {t('kds.board.orderNote')}
                    </span>
                    {order.order_note}
                </p>
            )}

            <div className="flex-1 px-1 py-2">
                {courses.map((group) => (
                    <section key={group.courseIndex ?? 'none'}>
                        {group.courseIndex !== null && courses.length > 1 && (
                            <h3 className="px-3 pb-1 pt-2 text-base font-bold uppercase tracking-wider text-kitchen-new">
                                {t('kds.board.course', { index: group.courseIndex })}
                            </h3>
                        )}
                        <ul>
                            {group.lines.map((line) => (
                                <TicketLineRow
                                    key={line.id || line.uuid}
                                    line={line}
                                    onToggle={() => onToggleLine(order.id, line.id)}
                                />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>

            {variant === 'board' && (
                <footer className="flex gap-2 border-t border-kitchen-border p-2">
                    <button
                        type="button"
                        onClick={() => onAdvance(order.id)}
                        className="min-h-touch-lg flex-1 rounded-pos bg-kitchen-raised px-3 text-lg font-bold text-kitchen-text ring-1 ring-inset ring-kitchen-border active:brightness-125"
                    >
                        {t('kds.board.advance')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onComplete(order.id)}
                        className={cn(
                            'min-h-touch-lg flex-1 rounded-pos px-3 text-lg font-bold active:brightness-110',
                            complete
                                ? 'bg-kitchen-served text-white'
                                : 'bg-kitchen-ready text-kitchen-bg',
                        )}
                    >
                        {t('kds.board.allDone')}
                    </button>
                </footer>
            )}

            {variant === 'recall' && (
                <footer className="border-t border-kitchen-border p-2">
                    <button
                        type="button"
                        onClick={() => onRecall(order.id)}
                        className="min-h-touch w-full rounded-pos bg-kitchen-new/20 px-3 text-lg font-bold text-kitchen-new ring-1 ring-inset ring-kitchen-new/50 active:brightness-125"
                    >
                        {t('kds.board.recall')}
                    </button>
                </footer>
            )}
        </article>
    );
}

function Badge({
    children,
    tone,
}: {
    children: ReactNode;
    tone: 'table' | 'takeaway' | 'muted';
}): JSX.Element {
    return (
        <span
            className={cn(
                'rounded px-2 py-0.5 text-base font-bold',
                tone === 'table' && 'bg-kitchen-new/25 text-kitchen-new',
                tone === 'takeaway' && 'bg-kitchen-cooking/25 text-kitchen-cooking',
                tone === 'muted' && 'bg-kitchen-raised text-kitchen-muted',
            )}
        >
            {children}
        </span>
    );
}

/** One item row. Its own tap target, its own state, ≥ 64 px tall (KDS-006, KDS-010). */
function TicketLineRow({ line, onToggle }: { line: KitchenLine; onToggle: () => void }): JSX.Element {
    const t = useT();
    const cancelled = isLineCancelled(line);
    const changed = isLineChanged(line);
    const done = isLineDone(line) && !cancelled;
    const quantity = formatQty(line.quantity);

    return (
        <li>
            <button
                type="button"
                onClick={onToggle}
                disabled={cancelled}
                aria-pressed={done}
                className={cn(
                    'flex min-h-touch-lg w-full items-start gap-3 rounded-pos px-3 py-2 text-start',
                    'active:bg-kitchen-raised disabled:cursor-not-allowed',
                    cancelled && 'bg-kitchen-late/15 ring-1 ring-inset ring-kitchen-late/50',
                    changed && !cancelled && 'bg-kitchen-cooking/10',
                    line.state === 'in_progress' && 'bg-kitchen-cooking/10',
                )}
            >
                <span
                    className={cn(
                        'mt-0.5 min-w-[2.5rem] rounded px-1.5 py-0.5 text-center text-2xl font-black tabular-nums',
                        cancelled ? 'bg-kitchen-late text-white' : 'bg-kitchen-raised text-kitchen-text',
                    )}
                >
                    {quantity}
                </span>

                <span className="min-w-0 flex-1">
                    <span
                        className={cn(
                            'block text-xl font-bold leading-tight',
                            cancelled && 'text-kitchen-late line-through',
                            done && 'text-kitchen-served line-through',
                        )}
                    >
                        {line.display_name}
                    </span>

                    {cancelled && (
                        <span className="mt-1 inline-block rounded bg-kitchen-late px-2 py-0.5 text-base font-bold uppercase text-white">
                            {t('kds.board.cancelled')}
                        </span>
                    )}
                    {changed && !cancelled && (
                        <span className="mt-1 inline-block rounded bg-kitchen-cooking px-2 py-0.5 text-base font-bold uppercase text-kitchen-bg">
                            {t('kds.board.noteUpdate')}
                        </span>
                    )}
                    {line.change_type === 'fire_course' && (
                        <span className="mt-1 inline-block rounded bg-kitchen-new px-2 py-0.5 text-base font-bold uppercase text-kitchen-bg">
                            {t('kds.board.fired')}
                        </span>
                    )}

                    {line.customer_note && <Note text={line.customer_note} tone="customer" />}
                    {line.internal_note && <Note text={line.internal_note} tone="internal" />}
                </span>

                <span
                    className={cn(
                        'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xl font-black',
                        done ? 'bg-kitchen-ready text-kitchen-bg' : 'ring-2 ring-kitchen-border',
                    )}
                    aria-hidden="true"
                >
                    {done ? '✓' : ''}
                </span>
            </button>
        </li>
    );
}

/** Notes are loud on purpose (KDS-006). */
function Note({ text, tone }: { text: string; tone: 'customer' | 'internal' }): JSX.Element {
    return (
        <span
            className={cn(
                'mt-1 block rounded px-2 py-1 text-lg font-bold leading-snug',
                tone === 'customer'
                    ? 'bg-kitchen-new/20 text-kitchen-new ring-1 ring-inset ring-kitchen-new/40'
                    : 'bg-kitchen-cooking/20 text-kitchen-cooking ring-1 ring-inset ring-kitchen-cooking/40',
            )}
        >
            {text}
        </span>
    );
}

/**
 * Quantities arrive as decimal strings and are usually whole (spec §0.1). `2.000` renders as `2`;
 * `0.750` keeps its decimals because that is a weighed item and the number matters.
 */
export function formatQty(quantity: string): string {
    const value = Number.parseFloat(quantity);
    if (!Number.isFinite(value)) return quantity;
    const abs = Math.abs(value);
    const text = Number.isInteger(value) ? String(abs) : String(Number(abs.toFixed(3)));
    return value < 0 ? `−${text}` : `${text}×`;
}
