import { describe, expect, it } from 'vitest';

import {
    DEFAULT_BOUNDS,
    DEFAULT_GRID,
    MIN_SIZE,
    centreOf,
    clampToBounds,
    duplicateRect,
    findOverlaps,
    moveRect,
    overlaps,
    planBounds,
    resizeRect,
    rotateRect,
    seatPositions,
    snap,
    snapRect,
    type Bounds,
    type Handle,
    type Rect,
} from './geometry';

/** Unit coverage for the floor-plan editor's geometry. Every operation must return a new rect. */

const TABLE: Rect = { x: 100, y: 100, width: 100, height: 100 };
const FLOOR: Bounds = { width: 1200, height: 800 };

describe('snap', () => {
    it.each([
        { value: 23, grid: 10, expected: 20 },
        { value: 25, grid: 10, expected: 30 },
        { value: 0, grid: 10, expected: 0 },
        { value: -23, grid: 10, expected: -20 },
        { value: 7.126, grid: 0, expected: 7.13 },
        { value: 7.126, grid: -5, expected: 7.13 },
        { value: 12.5, grid: 5, expected: 15 },
    ])('snap($value, $grid) → $expected', ({ value, grid, expected }) => {
        expect(snap(value, grid)).toBe(expected);
    });

    it('defaults to the 10 px grid', () => {
        expect(snap(23)).toBe(snap(23, DEFAULT_GRID));
    });

    it('turns a non-finite value into 0 rather than propagating NaN through the plan', () => {
        expect(snap(Number.NaN)).toBe(0);
        expect(snap(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('snapRect', () => {
    it('snaps position and size, and never shrinks a table below the minimum', () => {
        expect(snapRect({ x: 23, y: 27, width: 15, height: 4 })).toEqual({
            x: 20,
            y: 30,
            width: MIN_SIZE,
            height: MIN_SIZE,
        });
    });

    it('returns a new object', () => {
        const result = snapRect(TABLE);
        expect(result).not.toBe(TABLE);
        expect(TABLE).toEqual({ x: 100, y: 100, width: 100, height: 100 });
    });
});

describe('clampToBounds', () => {
    it('keeps a table inside the floor', () => {
        expect(clampToBounds({ x: -50, y: 2000, width: 100, height: 50 }, FLOOR)).toEqual({
            x: 0,
            y: 750,
            width: 100,
            height: 50,
        });
    });

    it('clamps the size before the position, so an oversized table lands at the origin', () => {
        expect(clampToBounds({ x: 400, y: 400, width: 2000, height: 2000 }, FLOOR)).toEqual({
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
        });
    });

    it('enforces the minimum size even without bounds', () => {
        expect(clampToBounds({ x: 5, y: 5, width: 1, height: 1 }, undefined)).toEqual({
            x: 5,
            y: 5,
            width: MIN_SIZE,
            height: MIN_SIZE,
        });
    });

    it('honours a custom minimum', () => {
        expect(clampToBounds({ x: 0, y: 0, width: 1, height: 1 }, FLOOR, 40)).toMatchObject({
            width: 40,
            height: 40,
        });
    });
});

describe('moveRect', () => {
    it('snaps the drag delta to the grid', () => {
        expect(moveRect({ x: 0, y: 0, width: 100, height: 60 }, 23, 27)).toEqual({
            x: 20,
            y: 30,
            width: 100,
            height: 60,
        });
    });

    it('stops at the floor edge instead of pushing the table out of sight', () => {
        expect(moveRect(TABLE, 5000, 5000, { bounds: FLOOR })).toEqual({
            x: 1100,
            y: 700,
            width: 100,
            height: 100,
        });
        expect(moveRect(TABLE, -5000, -5000, { bounds: FLOOR })).toMatchObject({ x: 0, y: 0 });
    });

    it('moves freely with snapping disabled', () => {
        expect(moveRect(TABLE, 3, 7, { grid: 0 })).toMatchObject({ x: 103, y: 107 });
    });
});

describe('resizeRect', () => {
    it.each<{ handle: Handle; dx: number; dy: number; expected: Rect }>([
        { handle: 'e', dx: 23, dy: 0, expected: { x: 100, y: 100, width: 120, height: 100 } },
        { handle: 'w', dx: -23, dy: 0, expected: { x: 80, y: 100, width: 120, height: 100 } },
        { handle: 's', dx: 0, dy: 23, expected: { x: 100, y: 100, width: 100, height: 120 } },
        { handle: 'n', dx: 0, dy: -23, expected: { x: 100, y: 80, width: 100, height: 120 } },
        { handle: 'se', dx: 23, dy: 23, expected: { x: 100, y: 100, width: 120, height: 120 } },
        { handle: 'nw', dx: -23, dy: -23, expected: { x: 80, y: 80, width: 120, height: 120 } },
        { handle: 'ne', dx: 23, dy: -23, expected: { x: 100, y: 80, width: 120, height: 120 } },
        { handle: 'sw', dx: -23, dy: 23, expected: { x: 80, y: 100, width: 120, height: 120 } },
    ])('drags the $handle handle', ({ handle, dx, dy, expected }) => {
        expect(resizeRect(TABLE, handle, dx, dy)).toEqual(expected);
    });

    it('keeps the opposite edge fixed when a west drag hits the minimum', () => {
        const result = resizeRect(TABLE, 'w', 95, 0);
        expect(result).toEqual({ x: 180, y: 100, width: MIN_SIZE, height: 100 });
        // right edge unchanged
        expect(result.x + result.width).toBe(TABLE.x + TABLE.width);
    });

    it('keeps the opposite edge fixed when a north drag hits the minimum', () => {
        const result = resizeRect(TABLE, 'n', 0, 95);
        expect(result).toEqual({ x: 100, y: 180, width: 100, height: MIN_SIZE });
        expect(result.y + result.height).toBe(TABLE.y + TABLE.height);
    });

    it('stops an east drag at the minimum without moving the left edge', () => {
        const result = resizeRect(TABLE, 'e', -95, 0);
        expect(result).toEqual({ x: 100, y: 100, width: MIN_SIZE, height: 100 });
    });

    it('never resizes a table past the floor', () => {
        expect(resizeRect(TABLE, 'se', 5000, 5000, { bounds: FLOOR })).toMatchObject({
            width: 1200,
            height: 800,
        });
    });

    it('honours a custom minimum size', () => {
        expect(resizeRect(TABLE, 'e', -95, 0, { min: 40 })).toMatchObject({ width: 40 });
    });
});

describe('rotateRect', () => {
    it('swaps the sides about the centre', () => {
        expect(rotateRect({ x: 100, y: 100, width: 120, height: 60 })).toEqual({
            x: 130,
            y: 70,
            width: 60,
            height: 120,
        });
    });

    it('is (near enough) its own inverse for a grid-aligned table', () => {
        const once = rotateRect({ x: 100, y: 100, width: 120, height: 60 });
        expect(rotateRect(once)).toEqual({ x: 100, y: 100, width: 120, height: 60 });
    });

    it('keeps the rotated table on the floor', () => {
        expect(rotateRect({ x: 0, y: 780, width: 200, height: 40 }, { bounds: FLOOR })).toMatchObject({
            width: 40,
            height: 200,
            y: 600,
        });
    });
});

describe('overlaps / findOverlaps', () => {
    it('detects an intersection', () => {
        expect(overlaps({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toBe(
            true,
        );
    });

    it('lets two tables sit flush — touching edges are not an overlap', () => {
        expect(
            overlaps({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 }),
        ).toBe(false);
        expect(
            overlaps({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 100, width: 100, height: 100 }),
        ).toBe(false);
    });

    it('reports separated tables as clear', () => {
        expect(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 500, y: 500, width: 10, height: 10 })).toBe(
            false,
        );
    });

    it('returns every colliding neighbour', () => {
        const others = [
            { id: 1, x: 0, y: 0, width: 100, height: 100 },
            { id: 2, x: 90, y: 90, width: 100, height: 100 },
            { id: 3, x: 500, y: 500, width: 100, height: 100 },
        ];
        expect(findOverlaps({ x: 50, y: 50, width: 100, height: 100 }, others).map((o) => o.id)).toEqual([1, 2]);
    });
});

describe('duplicateRect', () => {
    const original: Rect = { x: 0, y: 0, width: 100, height: 60 };

    it('cascades diagonally until it finds free space', () => {
        expect(duplicateRect(original, [original])).toEqual({ x: 60, y: 60, width: 100, height: 60 });
    });

    it('lands one step away when nothing is in the way', () => {
        expect(duplicateRect(original, [])).toEqual({ x: 20, y: 20, width: 100, height: 60 });
    });

    it('gives up after the attempt budget and returns a draggable candidate', () => {
        // A floor barely bigger than the table pins every candidate on top of the original.
        const result = duplicateRect(original, [original], {
            bounds: { width: 100, height: 60 },
            attempts: 3,
        });
        expect(result).toEqual({ x: 0, y: 0, width: 100, height: 60 });
    });

    it('honours a custom step', () => {
        expect(duplicateRect(original, [], { step: 40 })).toMatchObject({ x: 40, y: 40 });
    });
});

describe('centreOf and planBounds', () => {
    it('computes the centre', () => {
        expect(centreOf({ x: 100, y: 100, width: 120, height: 60 })).toEqual({ x: 160, y: 130 });
    });

    it('starts from the minimum canvas and grows with the tables', () => {
        expect(planBounds([])).toEqual(DEFAULT_BOUNDS);
        expect(planBounds([{ x: 1200, y: 0, width: 100, height: 60 }])).toEqual({ width: 1340, height: 800 });
        expect(planBounds([{ x: 0, y: 900, width: 100, height: 60 }])).toEqual({ width: 1200, height: 1000 });
    });
});

describe('seatPositions', () => {
    it('returns nothing for a table with no seats', () => {
        expect(seatPositions(TABLE, 0, true)).toEqual([]);
        expect(seatPositions(TABLE, -4, true)).toEqual([]);
    });

    it('caps at 24 markers, however many seats the row claims', () => {
        expect(seatPositions(TABLE, 100, true)).toHaveLength(24);
    });

    it('places round-table seats on the circumscribed ellipse, starting at the top', () => {
        expect(seatPositions({ x: 0, y: 0, width: 100, height: 100 }, 4, true)).toEqual([
            { x: 50, y: -8 },
            { x: 108, y: 50 },
            { x: 50, y: 108 },
            { x: -8, y: 50 },
        ]);
    });

    it('walks the perimeter of a rectangular table clockwise from the top-left', () => {
        expect(seatPositions({ x: 0, y: 0, width: 100, height: 100 }, 4, false)).toEqual([
            { x: 0, y: -8 },
            { x: 108, y: 0 },
            { x: 100, y: 108 },
            { x: -8, y: 100 },
        ]);
    });

    it('truncates a fractional seat count', () => {
        expect(seatPositions(TABLE, 2.9, false)).toHaveLength(2);
    });
});
