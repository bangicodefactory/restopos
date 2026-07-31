import type { OrderLineRow } from '@domain/types';

/**
 * Bill splitting (RST-100 … RST-106) — the arithmetic half, kept pure so it is testable without a
 * store, a database or a React tree.
 *
 * Two rules that are easy to get wrong and expensive when they are:
 *
 *  - **A combo moves as a whole.** Selecting a combo child on its own would produce a bill with a
 *    half-priced main and no parent, and a kitchen ticket for neither.
 *  - **The selection is capped at the line's own quantity**, per line, every time it is read. A
 *    double-tap on the confirm button is the documented way to duplicate revenue (RST-106), so the
 *    clamp lives in the data, not in the button's disabled state.
 */

export type SplitSelection = Record<string, number>;

export type SplitPart = { line: OrderLineRow; quantity: number };

export type SplitPreview = {
    moved: SplitPart[];
    remaining: SplitPart[];
    movedCount: number;
};

/** Tap cycling: 0 → 1 → … → max → 0 (RST-100). */
export function cycleSplitQuantity(current: number, max: number): number {
    const next = Math.round((current + 1) * 1000) / 1000;
    return next > max ? 0 : next;
}

/**
 * Normalise a raw selection: clamp per line, drop zeroes, and propagate a parent's selection to its
 * combo children proportionally (a half-quantity parent takes half of each child).
 */
export function clampSelection(lines: readonly OrderLineRow[], selection: SplitSelection): SplitSelection {
    const byUuid = new Map(lines.map((line) => [line.uuid as string, line]));
    const out: SplitSelection = {};

    for (const line of lines) {
        if (line.combo_parent_uuid !== null) continue;
        const raw = selection[line.uuid] ?? 0;
        const quantity = Math.min(Math.max(raw, 0), Math.abs(line.quantity)) * Math.sign(line.quantity || 1);
        if (quantity === 0) continue;
        out[line.uuid] = quantity;

        const ratio = line.quantity === 0 ? 0 : quantity / line.quantity;
        for (const child of lines) {
            if (child.combo_parent_uuid !== line.uuid) continue;
            const childQuantity = Math.round(child.quantity * ratio * 1000) / 1000;
            if (childQuantity !== 0) out[child.uuid] = childQuantity;
        }
    }

    // Children whose parent is not in this order (defensive: a merge could have moved it).
    for (const [uuid, quantity] of Object.entries(selection)) {
        const line = byUuid.get(uuid);
        if (!line || out[uuid] !== undefined) continue;
        if (line.combo_parent_uuid === null) continue;
        if (byUuid.has(line.combo_parent_uuid)) continue;
        const clamped = Math.min(Math.max(quantity, 0), Math.abs(line.quantity));
        if (clamped > 0) out[uuid] = clamped;
    }

    return out;
}

/** What each side of the split ends up with. */
export function splitPreview(lines: readonly OrderLineRow[], selection: SplitSelection): SplitPreview {
    const clamped = clampSelection(lines, selection);
    const moved: SplitPart[] = [];
    const remaining: SplitPart[] = [];

    for (const line of lines) {
        const taken = clamped[line.uuid] ?? 0;
        if (taken !== 0) moved.push({ line, quantity: taken });
        const left = Math.round((line.quantity - taken) * 1000) / 1000;
        if (left !== 0) remaining.push({ line, quantity: left });
    }

    return { moved, remaining, movedCount: moved.length };
}

/** `…B`, `…C`, … up to 26 parts (RST-101). */
export function nextSplitLetter(usedLetters: readonly (string | null)[]): string | null {
    const used = new Set(usedLetters.filter((letter): letter is string => letter !== null));
    for (let index = 1; index < 26; index++) {
        const letter = String.fromCharCode(65 + index);
        if (!used.has(letter)) return letter;
    }
    return null;
}

/**
 * How the kitchen-sent quantities are divided between the two orders (RST-102 / RST-056).
 *
 * The already-sent quantity follows the lines. Whatever moves to the new bill is subtracted from
 * the original's snapshot, so neither order re-fires what the kitchen already cooked.
 */
export function splitPrepSnapshot(
    snapshotLines: Record<string, number>,
    keyOf: (lineUuid: string) => string | null,
    moved: readonly SplitPart[],
): { original: Record<string, number>; split: Record<string, number> } {
    const original = { ...snapshotLines };
    const split: Record<string, number> = {};

    for (const part of moved) {
        const key = keyOf(part.line.uuid);
        if (key === null) continue;
        const sent = original[key] ?? 0;
        if (sent === 0) continue;
        const takes = Math.min(Math.abs(sent), Math.abs(part.quantity)) * Math.sign(sent || 1);
        split[key] = takes;
        const left = Math.round((sent - takes) * 1000) / 1000;
        if (left === 0) delete original[key];
        else original[key] = left;
    }

    return { original, split };
}
