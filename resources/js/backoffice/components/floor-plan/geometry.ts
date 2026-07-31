/**
 * Floor-plan geometry: snapping, dragging, resizing, collision, duplication.
 *
 * Pure functions, no DOM, no React — the canvas below is a thin renderer over these, and this is
 * the file the unit tests point at (`geometry.test.ts`). Every operation returns a **new** rect;
 * nothing mutates, so an undo stack is a list of previous rects.
 *
 * Coordinates match `restaurant_tables`: `position_x`, `position_y`, `width`, `height`, all
 * `decimal(10,2)`, origin at the floor's top-left, unit = one plan pixel.
 *
 * **Rotation.** The schema has no angle column, so "rotate" here swaps width and height about the
 * table's centre — a 120×60 banquet table becomes 60×120 and stays where it was. That is the
 * honest 90° rotation the storage can express; a free angle would be UI state that vanishes on
 * reload.
 */

export type Rect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type Bounds = {
    width: number;
    height: number;
};

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export type GeometryOptions = {
    /** 0 disables snapping. */
    grid?: number;
    bounds?: Bounds;
    min?: number;
};

export const DEFAULT_GRID = 10;
export const MIN_SIZE = 20;
export const DEFAULT_BOUNDS: Bounds = { width: 1200, height: 800 };

/** Round to the nearest grid step. `grid <= 0` passes the value through. */
export function snap(value: number, grid: number = DEFAULT_GRID): number {
    if (!Number.isFinite(value)) return 0;
    if (grid <= 0) return round2(value);
    return round2(Math.round(value / grid) * grid);
}

export function snapRect(rect: Rect, grid: number = DEFAULT_GRID): Rect {
    return {
        x: snap(rect.x, grid),
        y: snap(rect.y, grid),
        width: Math.max(MIN_SIZE, snap(rect.width, grid)),
        height: Math.max(MIN_SIZE, snap(rect.height, grid)),
    };
}

/**
 * Keep a rect inside the plan.
 *
 * Size is clamped before position, because a table wider than the floor has no legal position and
 * silently pushing it off-canvas is how a plan ends up with a table nobody can find.
 */
export function clampToBounds(rect: Rect, bounds: Bounds | undefined, min: number = MIN_SIZE): Rect {
    if (!bounds) return { ...rect, width: Math.max(min, rect.width), height: Math.max(min, rect.height) };

    const width = Math.min(Math.max(min, rect.width), bounds.width);
    const height = Math.min(Math.max(min, rect.height), bounds.height);

    return {
        width,
        height,
        x: round2(Math.min(Math.max(0, rect.x), bounds.width - width)),
        y: round2(Math.min(Math.max(0, rect.y), bounds.height - height)),
    };
}

export function moveRect(rect: Rect, dx: number, dy: number, options: GeometryOptions = {}): Rect {
    const grid = options.grid ?? DEFAULT_GRID;
    return clampToBounds(
        {
            ...rect,
            x: snap(rect.x + dx, grid),
            y: snap(rect.y + dy, grid),
        },
        options.bounds,
        options.min ?? MIN_SIZE,
    );
}

/**
 * Resize from one of the eight handles.
 *
 * The subtle part is the minimum-size clamp on a north/west handle: the *opposite* edge must stay
 * put, so once the table hits the minimum the moving edge stops rather than dragging the whole
 * table backwards — which is what a naive `width = max(min, width)` does and what makes a resize
 * feel broken.
 */
export function resizeRect(
    rect: Rect,
    handle: Handle,
    dx: number,
    dy: number,
    options: GeometryOptions = {},
): Rect {
    const grid = options.grid ?? DEFAULT_GRID;
    const min = options.min ?? MIN_SIZE;

    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;

    let { x, y, width, height } = rect;

    if (handle.includes('w')) {
        x = snap(rect.x + dx, grid);
        width = right - x;
    }
    if (handle.includes('e')) {
        width = snap(right + dx, grid) - x;
    }
    if (handle.includes('n')) {
        y = snap(rect.y + dy, grid);
        height = bottom - y;
    }
    if (handle.includes('s')) {
        height = snap(bottom + dy, grid) - y;
    }

    if (width < min) {
        if (handle.includes('w')) x = right - min;
        width = min;
    }
    if (height < min) {
        if (handle.includes('n')) y = bottom - min;
        height = min;
    }

    return clampToBounds({ x: round2(x), y: round2(y), width: round2(width), height: round2(height) }, options.bounds, min);
}

/** 90° rotation the schema can store: swap the sides around the centre. */
export function rotateRect(rect: Rect, options: GeometryOptions = {}): Rect {
    const centreX = rect.x + rect.width / 2;
    const centreY = rect.y + rect.height / 2;
    const grid = options.grid ?? DEFAULT_GRID;

    return clampToBounds(
        {
            width: rect.height,
            height: rect.width,
            x: snap(centreX - rect.height / 2, grid),
            y: snap(centreY - rect.width / 2, grid),
        },
        options.bounds,
        options.min ?? MIN_SIZE,
    );
}

/** Axis-aligned overlap. Touching edges do not overlap — two tables may sit flush. */
export function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function findOverlaps<T extends Rect>(rect: Rect, others: readonly T[]): T[] {
    return others.filter((other) => overlaps(rect, other));
}

/**
 * Where a duplicate of `rect` should land.
 *
 * Offsets by one step diagonally and keeps stepping while it lands on something, so
 * duplicate-duplicate-duplicate produces a readable cascade instead of a stack of three tables at
 * the same coordinates. Gives up after a bounded number of attempts and returns the last
 * candidate — a slightly overlapping table the operator can drag is better than a silent no-op.
 */
export function duplicateRect(
    rect: Rect,
    others: readonly Rect[],
    options: GeometryOptions & { step?: number; attempts?: number } = {},
): Rect {
    const grid = options.grid ?? DEFAULT_GRID;
    const step = options.step ?? Math.max(grid, 20);
    const attempts = options.attempts ?? 12;

    let candidate = clampToBounds(
        { ...rect, x: snap(rect.x + step, grid), y: snap(rect.y + step, grid) },
        options.bounds,
        options.min ?? MIN_SIZE,
    );

    for (let i = 0; i < attempts; i++) {
        if (findOverlaps(candidate, others).length === 0) return candidate;
        candidate = clampToBounds(
            { ...candidate, x: snap(candidate.x + step, grid), y: snap(candidate.y + step, grid) },
            options.bounds,
            options.min ?? MIN_SIZE,
        );
    }

    return candidate;
}

export function centreOf(rect: Rect): { x: number; y: number } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Seat markers around a table.
 *
 * Round tables get seats on the circumscribed ellipse; rectangular tables get them distributed
 * around the perimeter starting at the top edge. Purely decorative — `seats` is a number in the
 * database, not a set of positions — but a plan where a 2-top and an 8-top look identical is not
 * a plan anyone can read across a room.
 */
export function seatPositions(rect: Rect, seats: number, round: boolean): { x: number; y: number }[] {
    const count = Math.max(0, Math.min(24, Math.trunc(seats)));
    if (count === 0) return [];

    const centre = centreOf(rect);

    if (round) {
        const radiusX = rect.width / 2 + 8;
        const radiusY = rect.height / 2 + 8;
        return Array.from({ length: count }, (_, index) => {
            const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
            return {
                x: round2(centre.x + radiusX * Math.cos(angle)),
                y: round2(centre.y + radiusY * Math.sin(angle)),
            };
        });
    }

    const perimeter = 2 * (rect.width + rect.height);
    return Array.from({ length: count }, (_, index) => {
        let distance = (index / count) * perimeter;

        if (distance < rect.width) return { x: round2(rect.x + distance), y: round2(rect.y - 8) };
        distance -= rect.width;

        if (distance < rect.height) return { x: round2(rect.x + rect.width + 8), y: round2(rect.y + distance) };
        distance -= rect.height;

        if (distance < rect.width) {
            return { x: round2(rect.x + rect.width - distance), y: round2(rect.y + rect.height + 8) };
        }
        distance -= rect.width;

        return { x: round2(rect.x - 8), y: round2(rect.y + rect.height - distance) };
    });
}

/** The plan's extent, so the canvas can grow with the tables placed on it. */
export function planBounds(rects: readonly Rect[], minimum: Bounds = DEFAULT_BOUNDS): Bounds {
    let width = minimum.width;
    let height = minimum.height;
    for (const rect of rects) {
        width = Math.max(width, rect.x + rect.width + 40);
        height = Math.max(height, rect.y + rect.height + 40);
    }
    return { width: round2(width), height: round2(height) };
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
