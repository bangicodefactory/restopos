import { cn } from '@shared/ui';
import type { JSX } from 'react';

import { useT } from '../i18n';
import type { BoardView } from '../logic/board';
import type { KitchenDisplay, KitchenOrder, KitchenStage } from '../types';
import { TicketCard } from './TicketCard';

/**
 * The two layouts (KDS-013).
 *
 * `columns` is the card wall a pass runs from: one column per configured stage, cards moving left
 * to right as they are bumped. `list` is the single-column view a small station wants on a portrait
 * screen — same cards, same order, no horizontal scrolling.
 *
 * Both render from the one `BoardView` projection, so a filter can never hide a ticket in one
 * layout and show it in the other.
 */

export type BoardProps = {
    view: BoardView;
    display: KitchenDisplay;
    layout: 'columns' | 'list';
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
