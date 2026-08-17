import { describe, expect, it } from 'vitest';

import { resolveFiscalPosition, winsFiscalPosition } from './fiscal-position-precedence';
import type { FiscalPositionState } from './fiscal-position-precedence';

/**
 * REG-175 (BAN-498) — which fiscal position wins.
 *
 * Four things set the tax mapping and they arrive in whatever sequence the service takes: the
 * register default at creation, the preset when the waiter picks "takeaway", the customer's own
 * mapping when they are attached, and a cashier choosing one by hand. All four called
 * `setFiscalPosition` directly, so the winner was **whichever ran last**.
 *
 * That is a wrong VAT rate on a real sale, decided by the order somebody happened to tap things in —
 * and it fails silently, because a fiscal position has no visible effect until the totals are
 * recomputed.
 */

const state = (id: number | null, source: FiscalPositionState['source']): FiscalPositionState => ({
    fiscalPositionId: id,
    source,
});

describe('the precedence ladder', () => {
    it('lets a stronger source take over', () => {
        expect(winsFiscalPosition('default', 'partner')).toBe(true);
        expect(winsFiscalPosition('partner', 'preset')).toBe(true);
        expect(winsFiscalPosition('preset', 'manual')).toBe(true);
    });

    it('refuses a weaker source', () => {
        expect(winsFiscalPosition('manual', 'preset')).toBe(false);
        expect(winsFiscalPosition('preset', 'partner')).toBe(false);
        expect(winsFiscalPosition('partner', 'default')).toBe(false);
    });

    it('lets a source replace itself', () => {
        // Choosing a second preset must move the mapping, and re-attaching a different customer must
        // move it too. Only a *weaker* source is refused.
        expect(winsFiscalPosition('preset', 'preset')).toBe(true);
        expect(winsFiscalPosition('manual', 'manual')).toBe(true);
    });
});

describe('the defect this exists to stop', () => {
    it('does not let a customer undo the takeaway rate', () => {
        // The bug, exactly: waiter taps Takeaway, then attaches the regular whose account carries a
        // different mapping, and the sale quietly goes out at the dine-in rate.
        const afterPreset = resolveFiscalPosition(state(null, 'default'), state(7, 'preset'));
        const afterCustomer = resolveFiscalPosition(afterPreset, state(3, 'partner'));

        expect(afterCustomer.fiscalPositionId).toBe(7);
        expect(afterCustomer.source).toBe('preset');
    });

    it('does not let a preset undo a hand-picked position', () => {
        const manual = resolveFiscalPosition(state(null, 'default'), state(9, 'manual'));

        expect(resolveFiscalPosition(manual, state(7, 'preset')).fiscalPositionId).toBe(9);
    });

    it('still lets the cashier override everything', () => {
        // Which is the escape hatch that makes preset-above-partner tolerable: an exempt customer
        // buying takeaway is a case for a human, and this is how they say so.
        const afterPreset = resolveFiscalPosition(state(null, 'default'), state(7, 'preset'));

        expect(resolveFiscalPosition(afterPreset, state(3, 'manual')).fiscalPositionId).toBe(3);
    });
});

describe('clearing a position', () => {
    it('is a decision, not an absence', () => {
        // A preset with no mapping means "no mapping for this service mode". Recorded as the
        // preset's decision, so a later partner default cannot fill the gap back in.
        const cleared = resolveFiscalPosition(state(3, 'partner'), state(null, 'preset'));

        expect(cleared.fiscalPositionId).toBeNull();
        expect(cleared.source).toBe('preset');
        expect(resolveFiscalPosition(cleared, state(5, 'partner')).fiscalPositionId).toBeNull();
    });
});

describe('an order that arrived without provenance', () => {
    it('is treated as the register default, so anything may set it', () => {
        // Orders come back from the server with no source — it is client-only. Treating that as
        // `manual` would freeze the mapping on every synced order.
        expect(winsFiscalPosition('default', 'partner')).toBe(true);
        expect(resolveFiscalPosition(state(1, 'default'), state(2, 'partner')).fiscalPositionId).toBe(2);
    });
});
