import { cn } from '@shared/ui';
import type { JSX } from 'react';

import { useT } from '../i18n';
import type { BoardLayout, BoardView, RollUpItem } from '../logic/board';
import { thresholdsFor, urgencyOf, type UrgencyLevel } from '../logic/elapsed';
import type { KitchenDisplay, KitchenOrder, KitchenStage } from '../types';
import { TicketCard, formatQty } from './TicketCard';

/**
 * The three layouts (KDS-013).
 *
 * `columns` is the card wall a pass runs from: one column per configured stage, cards moving left
 * to right as they are bumped. `list` is the single-column view a small station wants on a portrait
 * screen — same cards, same order, no horizontal scrolling. `grid` is the roll-up: no cards at all,
 * but identical items consolidated across every ticket on the board, so a fryer reads
 * "12 × frites" instead of counting twelve separate portions off twelve separate cards.
 *
 * All three render from the one `BoardView` projection, so a filter can never hide a ticket in one
 * layout and show it in another.
 */

export type BoardProps = {
    view: BoardView;
    display: KitchenDisplay;
    layout: BoardLayout;
    now: number;
    firstSeen: Record<number, number>;
    onAdvance: (orderId: number) => void;
    onRecall: (orderId: number) => void;
    onComplete: (orderId: number) => void;
    onToggleLine: (orderId: number, lineId: number) => void;
};

const STAGE_ACCENT: Record<string, string> = {
    todo: 'text-kitchen-new',
    in_progress: 'text-kitchen-cooking',
    ready: 'text-kitchen-ready',
    done: 'text-kitchen-served',
};

export function Board(props: BoardProps): JSX.Element {
    const t = useT();
    const { view, layout } = props;

    if (view.list.length === 0) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-3xl font-bold text-kitchen-muted">{t('kds.board.empty')}</p>
            </div>
        );
    }

    if (layout === 'grid') {
        // A board can hold open cards and still owe no *items* — a note-only ticket has no lines to
        // roll up. Saying so beats an empty pane that reads as a broken screen.
        if (view.rollUp.length === 0) {
            return (
                <div className="flex h-full items-center justify-center">
                    <p className="text-3xl font-bold text-kitchen-muted">{t('kds.board.rollUpEmpty')}</p>
                </div>
            );
        }

        return (
            <div className="pos-scroll h-full px-3 pb-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {view.rollUp.map((item) => (
                        <RollUpRow
                            key={item.key}
                            item={item}
                            display={props.display}
                            onToggleLine={props.onToggleLine}
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (layout === 'list') {
        return (
            <div className="pos-scroll h-full px-3 pb-3">
                <div className="mx-auto grid max-w-[64rem] grid-cols-1 gap-3">
                    {view.list.map((order) => (
                        <Card key={order.id} order={order} {...props} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="pos-scroll h-full">
            <div className="flex h-full min-w-full gap-3 px-3 pb-3">
                {view.columns.map((column) => (
                    <StageColumn key={column.stage.id} stage={column.stage} count={column.orders.length}>
                        {column.orders.map((order) => (
                            <Card key={order.id} order={order} {...props} />
                        ))}
                    </StageColumn>
                ))}
            </div>
        </div>
    );
}

function StageColumn({
    stage,
    count,
    children,
}: {
    stage: KitchenStage;
    count: number;
    children: JSX.Element[];
}): JSX.Element {
    const t = useT();
    return (
        <section className="flex h-full min-w-[22rem] flex-1 flex-col" aria-label={stage.name}>
            <h2
                className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-pos bg-kitchen-surface px-3 py-2 text-xl font-black uppercase tracking-wide ring-1 ring-inset ring-kitchen-border"
                style={stage.color ? { color: stage.color } : undefined}
            >
                <span className={cn(!stage.color && (STAGE_ACCENT[stage.stage_type] ?? 'text-kitchen-text'))}>
                    {stage.name}
                </span>
                <span className="rounded bg-kitchen-raised px-2 text-lg tabular-nums text-kitchen-muted">
                    {count}
                </span>
            </h2>
            <div className="pos-scroll mt-2 flex flex-1 flex-col gap-3">
                {count === 0 ? (
                    <p className="rounded-pos border border-dashed border-kitchen-border p-6 text-center text-lg text-kitchen-muted">
                        {t('kds.board.emptyStage')}
                    </p>
                ) : (
                    children
                )}
            </div>
        </section>
    );
}

const URGENCY_RING: Record<UrgencyLevel, string> = {
    fresh: 'ring-kitchen-border',
    warning: 'ring-kitchen-cooking',
    late: 'ring-kitchen-late',
    urgent: 'ring-kitchen-late',
};

/**
 * One line of production work (KDS-013).
 *
 * The quantity is the loudest thing on the row, for the same reason it is on a ticket card: this is
 * a number somebody reads across a kitchen and then cooks to. Underneath it sit the tickets the
 * total is owed to — tapping one ticks that ticket's line off, so a cook can cook the batch once
 * and then clear it card by card as the portions go out. Without those chips the roll-up would be
 * a read-only poster and the cook would have to switch layouts to bump anything.
 *
 * Urgency is judged on the **oldest** contributing card. A batch that is half fresh and half
 * fifteen minutes late is a late batch; averaging would hide the ticket that is in trouble.
 */
function RollUpRow({
    item,
    display,
    onToggleLine,
}: {
    item: RollUpItem;
    display: KitchenDisplay;
    onToggleLine: (orderId: number, lineId: number) => void;
}): JSX.Element {
    const t = useT();
    const level = urgencyOf(item.oldestSeconds, thresholdsFor(display));

    return (
        <section
            className={cn(
                'flex flex-col gap-2 rounded-pos bg-kitchen-surface p-3 ring-2 ring-inset',
                URGENCY_RING[level],
                level === 'urgent' && 'animate-pulse',
            )}
            aria-label={`${formatQty(String(item.quantity))} ${item.name}`}
        >
            <div className="flex items-start gap-3">
                <span className="min-w-[4rem] rounded bg-kitchen-raised px-2 py-1 text-center text-4xl font-black tabular-nums text-kitchen-text">
                    {formatQty(String(item.quantity))}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-2xl font-bold leading-tight">{item.name}</span>
                    {item.customerNote && <Note text={item.customerNote} tone="customer" />}
                    {item.internalNote && <Note text={item.internalNote} tone="internal" />}
                </span>
            </div>

            <p className="text-base font-semibold uppercase tracking-wide text-kitchen-muted">
                {item.sources.length === 1
                    ? t('kds.board.rollUpTicketsOne')
                    : t('kds.board.rollUpTickets', { count: item.sources.length })}
            </p>

            <ul className="flex flex-wrap gap-2">
                {item.sources.map((source) => (
                    <li key={`${source.orderId}-${source.lineId}`}>
                        <button
                            type="button"
                            onClick={() => onToggleLine(source.orderId, source.lineId)}
                            aria-label={`${source.label} · ${formatQty(String(source.quantity))} ${item.name}`}
                            className={cn(
                                'min-h-touch rounded-pos px-3 text-lg font-black tabular-nums ring-1 ring-inset active:brightness-125',
                                source.state === 'in_progress'
                                    ? 'bg-kitchen-cooking/20 text-kitchen-cooking ring-kitchen-cooking/50'
                                    : source.state === 'ready'
                                      ? 'bg-kitchen-ready/20 text-kitchen-ready ring-kitchen-ready/50'
                                      : 'bg-kitchen-raised text-kitchen-text ring-kitchen-border',
                            )}
                        >
                            {source.label}
                            <span className="ms-2 text-base font-bold text-kitchen-muted">
                                {formatQty(String(source.quantity))}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** Notes stay as loud here as they are on a card (KDS-006) — a roll-up must not swallow an allergy. */
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

function Card({ order, ...props }: BoardProps & { order: KitchenOrder }): JSX.Element {
    return (
        <TicketCard
            order={order}
            stages={props.view.stages}
            display={props.display}
            now={props.now}
            firstSeenAt={props.firstSeen[order.id]}
            onAdvance={props.onAdvance}
            onRecall={props.onRecall}
            onComplete={props.onComplete}
            onToggleLine={props.onToggleLine}
        />
    );
}
