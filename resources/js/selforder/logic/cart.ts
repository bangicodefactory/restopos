import { Decimal } from '@domain/money/decimal';
import { computeOrderTaxes } from '@domain/tax/engine';
import type { LineInput, OrderResult } from '@domain/tax/types';

import type { Catalog } from '../catalog';

/**
 * The basket (SLF-031, SLF-033, SLF-036, SLF-040).
 *
 * Two rules govern everything here, and both come from the contract rather than from taste:
 *
 *  1. **The cart never proposes a price.** `POST /api/self-order/{token}/orders` takes no
 *     `price_unit`; a payload that sends one has it ignored *and* recorded as a `price_tamper`
 *     conflict (spec §10). The prices computed in this module exist to show the customer a number
 *     before they commit — they are a quote, never an instruction.
 *  2. **The server's totals win.** After a submission the running total is replaced by
 *     `SelfOrderStatus.amount_total`, because pricelists, fiscal positions and combo splits are all
 *     resolved server-side and the client only approximates them.
 *
 * The module is pure and has no React or storage dependency, which is what makes the arithmetic
 * testable against the same tax engine the server is validated against.
 */

export type CartLine = {
    /** Client-minted; the anchor `combo_parent_uuid` points at. */
    uuid: string;
    variantId: number;
    productId: number;
    /** Frozen at add time, attributes included, so the cart does not re-render differently later. */
    name: string;
    quantity: number;
    /** Indicative unit price (see rule 1). Decimal string. */
    unitPrice: string;
    taxIds: number[];
    /** `product_attribute_line_value` ids — what the API calls `attribute_value_ids`. */
    attributeValueIds: number[];
    note: string | null;
    /** Combo wiring. A child line always has all three set. */
    comboParentUuid: string | null;
    comboId: number | null;
    comboItemId: number | null;
};

export type Cart = {
    lines: CartLine[];
};

export const EMPTY_CART: Cart = { lines: [] };

export type CartDraft = Omit<CartLine, 'uuid'> & { uuid?: string };

/** Injected so tests are deterministic and the app still gets real uuids. */
export type UuidSource = () => string;

/**
 * Two lines are "the same product ordered twice" only when *everything* a customer could have
 * chosen matches: variant, attribute extras and the note. A note change makes it a different item —
 * the same rule the kitchen's change-delta engine uses (KDS-051), and for the same reason: "no
 * onions" and "extra onions" must never be merged into a quantity of two.
 *
 * Combo lines are never merged. Two identical meal deals are still two meals with their own child
 * selections, and merging them would orphan the children.
 */
export function isSameLine(a: CartLine, b: Pick<CartLine, 'variantId' | 'attributeValueIds' | 'note' | 'comboId' | 'comboParentUuid'>): boolean {
    if (a.comboId !== null || b.comboId !== null) return false;
    if (a.comboParentUuid !== null || b.comboParentUuid !== null) return false;
    if (a.variantId !== b.variantId) return false;
    if ((a.note ?? '') !== (b.note ?? '')) return false;
    return sameIds(a.attributeValueIds, b.attributeValueIds);
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...a].sort((x, y) => x - y);
    const right = [...b].sort((x, y) => x - y);
    return left.every((value, index) => value === right[index]);
}

/**
 * Add a line, merging into an identical one when there is one.
 *
 * `children` are combo components: they are appended with their `comboParentUuid` rewritten to the
 * parent's freshly minted uuid, so the caller never has to know the uuid in advance.
 */
export function addLine(
    cart: Cart,
    draft: CartDraft,
    children: readonly CartDraft[] = [],
    newUuid: UuidSource = defaultUuid,
): Cart {
    if (draft.quantity <= 0) return cart;

    if (children.length === 0) {
        const existing = cart.lines.find((line) => isSameLine(line, draft));
        if (existing) {
            return {
                lines: cart.lines.map((line) =>
                    line.uuid === existing.uuid ? { ...line, quantity: line.quantity + draft.quantity } : line,
                ),
            };
        }
    }

    const parentUuid = draft.uuid ?? newUuid();
    const parent: CartLine = { ...draft, uuid: parentUuid };
    const childLines: CartLine[] = children.map((child) => ({
        ...child,
        uuid: child.uuid ?? newUuid(),
        comboParentUuid: parentUuid,
    }));

    return { lines: [...cart.lines, parent, ...childLines] };
}

/** Setting a quantity to zero removes the line — a stepper's `−` at 1 must not leave a ghost. */
export function setQuantity(cart: Cart, uuid: string, quantity: number): Cart {
    if (quantity <= 0) return removeLine(cart, uuid);
    return {
        lines: cart.lines.map((line) => (line.uuid === uuid ? { ...line, quantity } : line)),
    };
}

/** Removing a combo parent removes its children; a childless child never happens. */
export function removeLine(cart: Cart, uuid: string): Cart {
    return { lines: cart.lines.filter((line) => line.uuid !== uuid && line.comboParentUuid !== uuid) };
}

export function setNote(cart: Cart, uuid: string, note: string | null): Cart {
    const trimmed = note?.trim() ?? '';
    return {
        lines: cart.lines.map((line) =>
            line.uuid === uuid ? { ...line, note: trimmed === '' ? null : trimmed } : line,
        ),
    };
}

export function clearCart(): Cart {
    return { lines: [] };
}

export function cartCount(cart: Cart): number {
    // Combo children are part of their parent, not separate items on the badge.
    return cart.lines.reduce((total, line) => (line.comboParentUuid === null ? total + line.quantity : total), 0);
}

export function isEmpty(cart: Cart): boolean {
    return cart.lines.length === 0;
}

export function findLine(cart: Cart, uuid: string): CartLine | null {
    return cart.lines.find((line) => line.uuid === uuid) ?? null;
}

export function childrenOf(cart: Cart, uuid: string): CartLine[] {
    return cart.lines.filter((line) => line.comboParentUuid === uuid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals
// ─────────────────────────────────────────────────────────────────────────────

export type CartTotals = {
    /** Per-line tax-included total, keyed by line uuid — what the cart rows display. */
    lineTotals: Record<string, string>;
    totalExcluded: string;
    totalTax: string;
    totalIncluded: string;
    /** What the big number at the bottom shows, per the venue's `iface_tax_included`. */
    display: string;
    taxGroups: OrderResult['totals']['taxGroups'];
};

/**
 * Run the cart through the same tax engine the register and the server use.
 *
 * Not a hand-rolled `qty × price × (1 + rate)`: price-included taxes, tax groups, `include_base_amount`
 * chains and the round-per-line vs round-globally choice are all real in this codebase, and a
 * customer who is quoted 24,19 € and charged 24,20 € has been lied to. The engine is the one
 * implementation, unit-tested against the PHP one by the shared fixture corpus.
 */
export function cartTotals(cart: Cart, catalog: Catalog): CartTotals {
    const lines: LineInput[] = cart.lines.map((line) => ({
        id: line.uuid,
        quantity: String(line.quantity),
        priceUnit: line.unitPrice,
        taxIds: line.taxIds,
    }));

    if (lines.length === 0) {
        return {
            lineTotals: {},
            totalExcluded: '0.00',
            totalTax: '0.00',
            totalIncluded: '0.00',
            display: '0.00',
            taxGroups: [],
        };
    }

    const result = computeOrderTaxes({
        currency: {
            code: '',
            decimalPlaces: catalog.currency.decimalPlaces,
            rounding: roundingStep(catalog.currency.decimalPlaces),
        },
        roundingMethod: catalog.roundingMethod,
        taxes: catalog.taxes,
        lines,
    });

    const lineTotals: Record<string, string> = {};
    for (const line of result.lines) {
        lineTotals[line.id] = catalog.taxDisplay === 'total' ? line.priceTotal : line.priceSubtotal;
    }

    return {
        lineTotals,
        totalExcluded: result.totals.totalExcluded,
        totalTax: result.totals.totalTax,
        totalIncluded: result.totals.totalIncluded,
        display: catalog.taxDisplay === 'total' ? result.totals.totalIncluded : result.totals.totalExcluded,
        taxGroups: result.totals.taxGroups,
    };
}

/** The unit price to *show* on a product card, given the venue's tax display. */
export function displayUnitPrice(
    unitPrice: string,
    taxIds: readonly number[],
    catalog: Catalog,
): string {
    if (catalog.taxDisplay === 'subtotal') return Decimal.of(unitPrice).withScale(catalog.currency.decimalPlaces).toString();
    const result = computeOrderTaxes({
        currency: {
            code: '',
            decimalPlaces: catalog.currency.decimalPlaces,
            rounding: roundingStep(catalog.currency.decimalPlaces),
        },
        roundingMethod: catalog.roundingMethod,
        taxes: catalog.taxes,
        lines: [{ id: 'x', quantity: '1', priceUnit: unitPrice, taxIds: [...taxIds] }],
    });
    return result.totals.totalIncluded;
}

function roundingStep(decimalPlaces: number): string {
    if (decimalPlaces <= 0) return '1';
    return `0.${'0'.repeat(decimalPlaces - 1)}1`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission
// ─────────────────────────────────────────────────────────────────────────────

export type SubmitLine = {
    uuid: string;
    variant_id: number;
    quantity: number;
    customer_note: string | null;
    attribute_value_ids: number[];
    combo_parent_uuid: string | null;
    combo_item_id: number | null;
};

/**
 * The payload for `POST /api/self-order/{configToken}/orders`.
 *
 * Note what is *not* here: prices, taxes, product names, totals. The contract's line shape is
 * `{variant_id, quantity, customer_note, attribute_value_ids, combo_parent_uuid, combo_item_id}`
 * and this sends exactly that, plus the line `uuid` — without which `combo_parent_uuid` has nothing
 * to point at, since the server has never seen these lines before.
 */
export function toSubmitLines(cart: Cart): SubmitLine[] {
    return cart.lines.map((line) => ({
        uuid: line.uuid,
        variant_id: line.variantId,
        quantity: line.quantity,
        customer_note: line.note,
        attribute_value_ids: [...line.attributeValueIds],
        combo_parent_uuid: line.comboParentUuid,
        combo_item_id: line.comboItemId,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export type CartIssue = {
    uuid: string;
    name: string;
    reason: 'unavailable' | 'unknown';
};

/**
 * Drop lines whose product has been 86'd since it went in the basket (SLF-033).
 *
 * A live availability push can land while a customer is on the cart page. Submitting anyway would
 * earn a `422 cart_rejected` for the *whole* order, so the client prunes and explains instead. A
 * combo child going away takes its parent with it: half a meal deal is not a thing you can serve.
 */
export function validateCart(cart: Cart, catalog: Catalog): { cart: Cart; issues: CartIssue[] } {
    const issues: CartIssue[] = [];
    const doomed = new Set<string>();

    for (const line of cart.lines) {
        const product = catalog.productsById.get(line.productId);
        const variant = catalog.variantsById.get(line.variantId);
        if (!product || !variant) {
            issues.push({ uuid: line.uuid, name: line.name, reason: 'unknown' });
            doomed.add(line.comboParentUuid ?? line.uuid);
            continue;
        }
        if (!product.available || !variant.available) {
            issues.push({ uuid: line.uuid, name: line.name, reason: 'unavailable' });
            doomed.add(line.comboParentUuid ?? line.uuid);
        }
    }

    if (doomed.size === 0) return { cart, issues };

    return {
        cart: {
            lines: cart.lines.filter(
                (line) => !doomed.has(line.uuid) && !(line.comboParentUuid !== null && doomed.has(line.comboParentUuid)),
            ),
        },
        issues,
    };
}

/** A crypto uuid when the platform has one; a good-enough random otherwise (older iOS Safari). */
function defaultUuid(): string {
    const crypto = globalThis.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (crypto && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
