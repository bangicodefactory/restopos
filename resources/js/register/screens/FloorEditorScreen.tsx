import { useCan } from '@shared/auth';
import { FloorCanvas, type CanvasTable } from '@shared/floor-plan/FloorCanvas';
import type { Rect } from '@shared/floor-plan/geometry';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    addTable,
    boundsFor,
    createFloor,
    deleteTable,
    duplicateTable,
    renameFloor,
    saveBulkColor,
    saveGeometry,
    saveProperties,
} from '../domain/floor-editing';
import { useT } from '../i18n';
import { useCatalog } from '../hooks/use-register';

/**
 * Rearranging the room from the till (RST-030 … RST-038).
 *
 * Odoo puts an edit mode inside the point of sale, and it is the right place for it: the person who
 * knows the room is pushing two tables together in it, not sitting in the back office. The back
 * office keeps its own editor for setup; this is the same canvas, reachable where the change is
 * actually happening.
 *
 * Nothing here reimplements the plan. `@shared/floor-plan` owns the interaction model — snapping,
 * eight resize handles, keyboard nudge, collision highlighting — and moved out of `backoffice/` so
 * both surfaces run the same code rather than two drifting copies.
 *
 * **`config.manage` gates the door, and the server gates the write.** The ability check here is UX:
 * it keeps the button out of a waiter's way. `FloorController` refuses a table that is not on one of
 * this device's floors, which is the actual control.
 */

const SWATCHES: readonly (string | null)[] = [null, '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#bfdbfe', '#e9d5ff'];

export function FloorEditorScreen({ onExit }: { onExit: () => void }): JSX.Element {
    const t = useT();
    const catalog = useCatalog();
    const can = useCan();

    const [floorId, setFloorId] = useState<number | null>(catalog.floors[0]?.id ?? null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [extraIds, setExtraIds] = useState<number[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [seatsDraft, setSeatsDraft] = useState('');

    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollToId = useRef<number | null>(null);

    const tables = useMemo(
        () => catalog.tables.filter((table) => table.active && table.floor_id === floorId),
        [catalog.tables, floorId],
    );

    const selectedIds = useMemo(
        () => (selectedId === null ? extraIds : [selectedId, ...extraIds.filter((id) => id !== selectedId)]),
        [extraIds, selectedId],
    );

    const selected = useMemo(() => tables.find((table) => table.id === selectedId) ?? null, [selectedId, tables]);

    const selectedTables = useMemo(
        () => tables.filter((table) => selectedIds.includes(table.id)),
        [selectedIds, tables],
    );

    const bounds = useMemo(() => boundsFor(tables), [tables]);

    const canvasTables: CanvasTable[] = useMemo(
        () =>
            tables.map((table) => ({
                id: table.id,
                label: String(table.table_number),
                shape: table.shape === 'round' ? 'round' : 'square',
                seats: table.seats,
                color: table.color,
                linked: table.parent_id !== null,
                x: table.position_h,
                y: table.position_v,
                width: table.width,
                height: table.height,
            })),
        [tables],
    );

    const canvasLabels = useMemo(
        () => ({
            canvas: (count: number) => t('reg.floorEdit.canvas', { count }),
            seats: t('reg.floorEdit.seats'),
            linked: t('reg.floorEdit.linked'),
        }),
        [t],
    );

    /**
     * A table added off-screen is a table the manager thinks did not appear (RST-034).
     *
     * Smart placement walks outward until it finds free space, which on a busy floor is somewhere
     * below the fold. Scrolling happens after the catalog has re-rendered with the new row, so the
     * id is parked here and consumed by the effect rather than chased with a timeout.
     */
    useEffect(() => {
        const wanted = scrollToId.current;
        if (wanted === null) return;

        const node = scrollRef.current?.querySelector(`[data-table-id="${wanted}"]`);
        scrollToId.current = null;

        node?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }, [tables]);

    /** Follow the selection, and follow a saved value back — including one the server clamped. */
    useEffect(() => {
        setSeatsDraft(selected === null ? '' : String(selected.seats));
    }, [selected]);

    /** Every mutation goes through here, so a failure is always shown and never swallowed. */
    const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch {
            // Deliberately not the thrown message: these are network and validation failures whose
            // text is written for a developer. What a manager needs is that it did not save.
            setError('failed');
        } finally {
            setBusy(false);
        }
    }, []);

    const onGeometryChange = useCallback(
        (id: number, rect: Rect) => {
            const table = tables.find((candidate) => candidate.id === id);
            if (!table) return;

            void run(() => saveGeometry(table, rect));
        },
        [run, tables],
    );

    const toggleSelect = useCallback(
        (id: number) => {
            setExtraIds((current) =>
                current.includes(id) ? current.filter((other) => other !== id) : [...current, id],
            );
        },
        [],
    );

    if (!can('config.manage')) {
        // Belt and braces: the toggle is already hidden from a cashier, but a screen that can be
        // reached by any other route must not become a way around that.
        return (
            <div className="p-6 text-slate-600">
                <p>{t('reg.floorEdit.denied')}</p>
                <Button className="mt-4" onClick={onExit}>
                    {t('reg.floorEdit.done')}
                </Button>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3" data-testid="floor-editor">
            <div className="flex flex-wrap items-center gap-2">
                <select
                    aria-label={t('reg.floorEdit.floor')}
                    className="min-h-touch rounded-pos border border-slate-300 px-2"
                    value={floorId ?? ''}
                    onChange={(event) => {
                        setFloorId(Number(event.target.value));
                        setSelectedId(null);
                        setExtraIds([]);
                    }}
                >
                    {catalog.floors.map((floor) => (
                        <option key={floor.id} value={floor.id}>
                            {floor.name}
                        </option>
                    ))}
                </select>

                <Button
                    disabled={busy || floorId === null}
                    onClick={() => {
                        if (floorId === null) return;
                        void run(async () => {
                            const created = await addTable(floorId, selected ?? undefined);
                            scrollToId.current = created.id;
                            setSelectedId(created.id);
                        });
                    }}
                >
                    {t('reg.floorEdit.addTable')}
                </Button>

                <Button
                    disabled={busy || selected === null}
                    onClick={() => {
                        if (!selected) return;
                        void run(async () => {
                            const copy = await duplicateTable(selected);
                            scrollToId.current = copy.id;
                            setSelectedId(copy.id);
                        });
                    }}
                >
                    {t('reg.floorEdit.duplicateTable')}
                </Button>

                <Button
                    disabled={busy || selected === null}
                    onClick={() => {
                        if (!selected) return;
                        void run(async () => {
                            await deleteTable(selected);
                            setSelectedId(null);
                        });
                    }}
                >
                    {t('reg.floorEdit.deleteTable')}
                </Button>

                <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden="true" />

                <Button
                    disabled={busy}
                    onClick={() => {
                        const name = globalThis.prompt(t('reg.floorEdit.newFloorName'))?.trim();
                        if (!name) return;
                        void run(async () => setFloorId(await createFloor(name)));
                    }}
                >
                    {t('reg.floorEdit.addFloor')}
                </Button>

                <Button
                    disabled={busy || floorId === null}
                    onClick={() => {
                        if (floorId === null) return;
                        const name = globalThis.prompt(t('reg.floorEdit.newFloorName'))?.trim();
                        if (!name) return;
                        // Copies every table on the current floor, each through the same guarded
                        // create endpoint as any other table (RST-037).
                        void run(async () => setFloorId(await createFloor(name, floorId)));
                    }}
                >
                    {t('reg.floorEdit.duplicateFloor')}
                </Button>

                <Button
                    disabled={busy || floorId === null}
                    onClick={() => {
                        if (floorId === null) return;
                        const current = catalog.floors.find((floor) => floor.id === floorId)?.name ?? '';
                        const name = globalThis.prompt(t('reg.floorEdit.renameFloor'), current)?.trim();
                        if (!name) return;
                        void run(() => renameFloor(floorId, name));
                    }}
                >
                    {t('reg.floorEdit.rename')}
                </Button>

                <Button className="ml-auto" onClick={onExit} data-testid="floor-editor-done">
                    {t('reg.floorEdit.done')}
                </Button>
            </div>

            {error !== null ? (
                <p role="alert" className="rounded-pos bg-rose-100 px-3 py-2 text-rose-900">
                    {t('reg.floorEdit.saveFailed')}
                </p>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
                    {/* Anchors for scroll-into-view; the canvas itself is one SVG. */}
                    <div className="relative">
                        {tables.map((table) => (
                            <span
                                key={table.id}
                                data-table-id={table.id}
                                aria-hidden="true"
                                className="pointer-events-none absolute h-1 w-1"
                                style={{
                                    left: `${(table.position_h / bounds.width) * 100}%`,
                                    top: `${(table.position_v / bounds.height) * 100}%`,
                                }}
                            />
                        ))}
                        <FloorCanvas
                            tables={canvasTables}
                            labels={canvasLabels}
                            selectedId={selectedId}
                            selectedIds={selectedIds}
                            onSelect={(id) => {
                                setSelectedId(id);
                                if (id === null) setExtraIds([]);
                            }}
                            onToggleSelect={toggleSelect}
                            onGeometryChange={onGeometryChange}
                            bounds={bounds}
                            grid={10}
                            snapEnabled
                        />
                    </div>
                </div>

                <aside className="w-full shrink-0 rounded-pos-lg bg-slate-50 p-3 lg:w-72" aria-label={t('reg.floorEdit.properties')}>
                    {selected === null ? (
                        <p className="text-slate-500">{t('reg.floorEdit.pickATable')}</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <p className="font-semibold" data-testid="floor-editor-selection">
                                {t('reg.floorEdit.tableN', { number: String(selected.table_number) })}
                                {selectedTables.length > 1
                                    ? ` (+${selectedTables.length - 1})`
                                    : ''}
                            </p>

                            <label className="flex flex-col gap-1">
                                <span>{t('reg.floorEdit.seats')}</span>
                                {/* Committed on blur or Enter, not per keystroke. Bound straight to
                                    the saved value, "12" would PATCH a 1 on the way to the 2 — and
                                    since the field is controlled by what came back, the digit the
                                    manager typed would fight the digit the server returned. */}
                                <input
                                    type="number"
                                    min={1}
                                    max={999}
                                    value={seatsDraft}
                                    disabled={busy}
                                    className="min-h-touch rounded-pos border border-slate-300 px-2"
                                    onChange={(event) => setSeatsDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') event.currentTarget.blur();
                                    }}
                                    onBlur={() => {
                                        const seats = Number(seatsDraft);

                                        if (!Number.isInteger(seats) || seats < 1 || seats > 999) {
                                            setSeatsDraft(String(selected.seats));

                                            return;
                                        }

                                        if (seats === selected.seats) return;

                                        void run(() => saveProperties(selected, { seats }));
                                    }}
                                />
                            </label>

                            <label className="flex flex-col gap-1">
                                <span>{t('reg.floorEdit.shape')}</span>
                                <select
                                    value={selected.shape}
                                    disabled={busy}
                                    className="min-h-touch rounded-pos border border-slate-300 px-2"
                                    onChange={(event) =>
                                        void run(() =>
                                            saveProperties(selected, {
                                                shape: event.target.value === 'round' ? 'round' : 'square',
                                            }),
                                        )
                                    }
                                >
                                    <option value="square">{t('reg.floorEdit.square')}</option>
                                    <option value="round">{t('reg.floorEdit.round')}</option>
                                </select>
                            </label>

                            <div className="flex flex-col gap-1">
                                <span>
                                    {selectedTables.length > 1
                                        ? t('reg.floorEdit.colourN', { count: selectedTables.length })
                                        : t('reg.floorEdit.colour')}
                                </span>
                                <div className="flex flex-wrap gap-2">
                                    {SWATCHES.map((colour) => (
                                        <button
                                            key={colour ?? 'none'}
                                            type="button"
                                            disabled={busy}
                                            aria-label={colour ?? t('reg.floorEdit.noColour')}
                                            data-testid={`swatch-${colour ?? 'none'}`}
                                            className={cn(
                                                'h-touch w-touch rounded-pos ring-1 ring-inset ring-slate-300',
                                                selected.color === colour ? 'ring-2 ring-slate-900' : '',
                                            )}
                                            style={{ backgroundColor: colour ?? '#ffffff' }}
                                            onClick={() =>
                                                // One selection, one rule: with several tables picked
                                                // the swatch recolours all of them (RST-038).
                                                void run(() => saveBulkColor(selectedTables, colour))
                                            }
                                        />
                                    ))}
                                </div>
                            </div>

                            <p className="text-slate-500">{t('reg.floorEdit.multiHint')}</p>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}
