/**
 * The floor-plan canvas.
 *
 * SVG rather than `<canvas>`, for one decisive reason: every table becomes a real focusable
 * element with a real accessible name, so the plan is editable from the keyboard — Tab to move
 * between tables, arrows to move a table, Shift+arrows to resize, R to rotate. A `<canvas>` plan
 * is a picture that only a mouse can touch.
 *
 * Pointer maths converts client pixels to plan units through the SVG's own scale, so drag
 * tracking stays correct when the plan is scaled to fit a narrow screen.
 *
 * All geometry lives in `./geometry`; this file only turns gestures into calls on it.
 */

import { FOCUS_RING, cn } from '@shared/ui';
import { useCallback, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

import { useT } from '../../i18n';

import {
    DEFAULT_GRID,
    centreOf,
    findOverlaps,
    moveRect,
    resizeRect,
    rotateRect,
    seatPositions,
    type Bounds,
    type Handle,
    type Rect,
} from './geometry';

export type CanvasTable = Rect & {
    id: number;
    label: string;
    shape: 'square' | 'round';
    seats: number;
    color: string | null;
    linked: boolean;
};

export type FloorCanvasProps = {
    tables: readonly CanvasTable[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onGeometryChange: (id: number, rect: Rect) => void;
    bounds: Bounds;
    grid: number;
    snapEnabled: boolean;
    backgroundColor?: string | null;
    backgroundImageUrl?: string | null;
    onRotate?: (id: number) => void;
    onDuplicate?: (id: number) => void;
    onDelete?: (id: number) => void;
};

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_CURSOR: Record<Handle, string> = {
    nw: 'nwse-resize',
    n: 'ns-resize',
    ne: 'nesw-resize',
    e: 'ew-resize',
    se: 'nwse-resize',
    s: 'ns-resize',
    sw: 'nesw-resize',
    w: 'ew-resize',
};

type Drag =
    | { kind: 'move'; id: number; startX: number; startY: number; origin: Rect }
    | { kind: 'resize'; id: number; handle: Handle; startX: number; startY: number; origin: Rect }
    | null;

export function FloorCanvas({
    tables,
    selectedId,
    onSelect,
    onGeometryChange,
    bounds,
    grid,
    snapEnabled,
    backgroundColor,
    backgroundImageUrl,
    onRotate,
    onDuplicate,
    onDelete,
}: FloorCanvasProps): JSX.Element {
    const t = useT();
    const svgRef = useRef<SVGSVGElement>(null);
    const [drag, setDrag] = useState<Drag>(null);

    const effectiveGrid = snapEnabled ? grid || DEFAULT_GRID : 0;
    const options = useMemo(() => ({ grid: effectiveGrid, bounds }), [bounds, effectiveGrid]);

    /** Client pixels → plan units. */
    const scale = useCallback((): number => {
        const node = svgRef.current;
        if (!node) return 1;
        const box = node.getBoundingClientRect();
        return box.width === 0 ? 1 : bounds.width / box.width;
    }, [bounds.width]);

    const collisions = useMemo(() => {
        const map = new Map<number, boolean>();
        for (const table of tables) {
            const others = tables.filter((other) => other.id !== table.id);
            map.set(table.id, findOverlaps(table, others).length > 0);
        }
        return map;
    }, [tables]);

    const onPointerDownTable = useCallback(
        (event: ReactPointerEvent<SVGGElement>, table: CanvasTable) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            onSelect(table.id);
            setDrag({
                kind: 'move',
                id: table.id,
                startX: event.clientX,
                startY: event.clientY,
                origin: { x: table.x, y: table.y, width: table.width, height: table.height },
            });
        },
        [onSelect],
    );

    const onPointerDownHandle = useCallback(
        (event: ReactPointerEvent<SVGRectElement>, table: CanvasTable, handle: Handle) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({
                kind: 'resize',
                id: table.id,
                handle,
                startX: event.clientX,
                startY: event.clientY,
                origin: { x: table.x, y: table.y, width: table.width, height: table.height },
            });
        },
        [],
    );

    const onPointerMove = useCallback(
        (event: ReactPointerEvent<SVGElement>) => {
            if (drag === null) return;
            const factor = scale();
            const dx = (event.clientX - drag.startX) * factor;
            const dy = (event.clientY - drag.startY) * factor;

            if (drag.kind === 'move') {
                onGeometryChange(drag.id, moveRect(drag.origin, dx, dy, options));
            } else {
                onGeometryChange(drag.id, resizeRect(drag.origin, drag.handle, dx, dy, options));
            }
        },
        [drag, onGeometryChange, options, scale],
    );

    const endDrag = useCallback(() => setDrag(null), []);

    const onKeyDownTable = useCallback(
        (event: React.KeyboardEvent<SVGGElement>, table: CanvasTable) => {
            const step = event.shiftKey ? (effectiveGrid || 1) * 5 : effectiveGrid || 1;
            const rect: Rect = { x: table.x, y: table.y, width: table.width, height: table.height };

            const moves: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };

            const delta = moves[event.key];
            if (delta) {
                event.preventDefault();
                onSelect(table.id);
                // Alt turns the arrows into a resize of the south-east corner.
                onGeometryChange(
                    table.id,
                    event.altKey
                        ? resizeRect(rect, 'se', delta[0], delta[1], options)
                        : moveRect(rect, delta[0], delta[1], options),
                );
                return;
            }

            if (event.key === 'r' || event.key === 'R') {
                event.preventDefault();
                if (onRotate) onRotate(table.id);
                else onGeometryChange(table.id, rotateRect(rect, options));
                return;
            }

            if (event.key === 'd' || event.key === 'D') {
                event.preventDefault();
                onDuplicate?.(table.id);
                return;
            }

            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                onDelete?.(table.id);
            }
        },
        [effectiveGrid, onDelete, onDuplicate, onGeometryChange, onRotate, onSelect, options],
    );

    return (
        <div className="overflow-auto rounded-pos-lg ring-1 ring-slate-200">
            <svg
                ref={svgRef}
                role="application"
                aria-label={t('floor.canvasLabel', { count: tables.length })}
                viewBox={`0 0 ${bounds.width} ${bounds.height}`}
                className="block h-auto w-full touch-none select-none"
                style={{ backgroundColor: backgroundColor ?? '#f8fafc', aspectRatio: `${bounds.width} / ${bounds.height}` }}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerDown={(event) => {
                    if (event.target === svgRef.current) onSelect(null);
                }}
            >
                <defs>
                    <pattern id="floor-grid" width={effectiveGrid || DEFAULT_GRID} height={effectiveGrid || DEFAULT_GRID} patternUnits="userSpaceOnUse">
                        <path
                            d={`M ${effectiveGrid || DEFAULT_GRID} 0 L 0 0 0 ${effectiveGrid || DEFAULT_GRID}`}
                            fill="none"
                            stroke="#e2e8f0"
                            strokeWidth={1}
                        />
                    </pattern>
                </defs>

                {backgroundImageUrl ? (
                    <image
                        href={backgroundImageUrl}
                        x={0}
                        y={0}
                        width={bounds.width}
                        height={bounds.height}
                        preserveAspectRatio="xMidYMid slice"
                        opacity={0.7}
                    />
                ) : null}

                {snapEnabled ? <rect x={0} y={0} width={bounds.width} height={bounds.height} fill="url(#floor-grid)" /> : null}

                {tables.map((table) => {
                    const selected = table.id === selectedId;
                    const colliding = collisions.get(table.id) === true;
                    const centre = centreOf(table);
                    const fill = table.color ?? '#ffffff';

                    return (
                        <g
                            key={table.id}
                            tabIndex={0}
                            role="button"
                            aria-label={`${table.label} — ${table.seats} ${t('floor.seats')}`}
                            aria-pressed={selected}
                            onPointerDown={(event) => onPointerDownTable(event, table)}
                            onKeyDown={(event) => onKeyDownTable(event, table)}
                            onFocus={() => onSelect(table.id)}
                            className={cn('cursor-move outline-none', FOCUS_RING)}
                        >
                            {seatPositions(table, table.seats, table.shape === 'round').map((seat, index) => (
                                <circle key={index} cx={seat.x} cy={seat.y} r={5} fill="#cbd5e1" />
                            ))}

                            {table.shape === 'round' ? (
                                <ellipse
                                    cx={centre.x}
                                    cy={centre.y}
                                    rx={table.width / 2}
                                    ry={table.height / 2}
                                    fill={fill}
                                    stroke={colliding ? '#b91c1c' : selected ? '#2563eb' : '#94a3b8'}
                                    strokeWidth={selected || colliding ? 3 : 1.5}
                                />
                            ) : (
                                <rect
                                    x={table.x}
                                    y={table.y}
                                    width={table.width}
                                    height={table.height}
                                    rx={6}
                                    fill={fill}
                                    stroke={colliding ? '#b91c1c' : selected ? '#2563eb' : '#94a3b8'}
                                    strokeWidth={selected || colliding ? 3 : 1.5}
                                />
                            )}

                            <text
                                x={centre.x}
                                y={centre.y + 4}
                                textAnchor="middle"
                                fontSize={14}
                                fontWeight={600}
                                fill="#0f172a"
                                pointerEvents="none"
                            >
                                {table.label}
                            </text>

                            {table.linked ? (
                                <text
                                    x={centre.x}
                                    y={centre.y + 20}
                                    textAnchor="middle"
                                    fontSize={9}
                                    fill="#475569"
                                    pointerEvents="none"
                                >
                                    ⛓ {t('floor.linked')}
                                </text>
                            ) : null}

                            {selected
                                ? HANDLES.map((handle) => {
                                      const position = handlePosition(table, handle);
                                      return (
                                          <rect
                                              key={handle}
                                              x={position.x - 5}
                                              y={position.y - 5}
                                              width={10}
                                              height={10}
                                              fill="#ffffff"
                                              stroke="#2563eb"
                                              strokeWidth={2}
                                              style={{ cursor: HANDLE_CURSOR[handle] }}
                                              onPointerDown={(event) => onPointerDownHandle(event, table, handle)}
                                          />
                                      );
                                  })
                                : null}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function handlePosition(rect: Rect, handle: Handle): { x: number; y: number } {
    const midX = rect.x + rect.width / 2;
    const midY = rect.y + rect.height / 2;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;

    switch (handle) {
        case 'nw':
            return { x: rect.x, y: rect.y };
        case 'n':
            return { x: midX, y: rect.y };
        case 'ne':
            return { x: right, y: rect.y };
        case 'e':
            return { x: right, y: midY };
        case 'se':
            return { x: right, y: bottom };
        case 's':
            return { x: midX, y: bottom };
        case 'sw':
            return { x: rect.x, y: bottom };
        default:
            return { x: rect.x, y: midY };
    }
}
