import { describe, expect, it } from 'vitest';

import { openingFloatFor } from './session-actions';

/**
 * BAN-417 — what number the open pane sends as the opening float (REG-004).
 *
 * The server refuses a register that cannot trade whatever the till sends, and it computes the
 * expected float itself. This is the one decision left on the client, and it is the one that can
 * silently record money nobody counted.
 */

describe('openingFloatFor', () => {
    it('sends what was counted when the register counts its drawer', () => {
        expect(openingFloatFor({ cashControl: true, countedTotal: 150, expectedFloat: '125.4000' })).toBe('150.00');
    });

    it('never substitutes the expected float for a drawer that was not counted', () => {
        // The whole reason the rule is written down. An empty grid means an empty drawer — or a
        // cashier who has not started — and either way the expected is a claim about last night,
        // not an observation about this morning. Opening at 125.40 on an empty drawer hides the
        // shortfall until the close blames it on the wrong shift.
        expect(openingFloatFor({ cashControl: true, countedTotal: 0, expectedFloat: '125.4000' })).toBe('0.00');
    });

    it('carries the previous close over when there is no drawer to count', () => {
        // Without cash control there is no grid and no count to make. The pane used to hardcode
        // zero here, so every such register opened at zero however much was left in the till.
        expect(openingFloatFor({ cashControl: false, countedTotal: 0, expectedFloat: '125.4000' })).toBe('125.40');
    });

    it('ignores a counted total that cannot have come from a count', () => {
        // No grid is rendered without cash control, so a non-zero total here is stale state, not a
        // count — and deferring to it would open at a number nobody entered.
        expect(openingFloatFor({ cashControl: false, countedTotal: 999, expectedFloat: '10.0000' })).toBe('10.00');
    });

    it('falls back to zero when the server has not said what to expect', () => {
        // Offline, or a register that has never closed a session. Opening at zero is honest;
        // guessing is not.
        expect(openingFloatFor({ cashControl: false, countedTotal: 0, expectedFloat: null })).toBe('0.00');
        expect(openingFloatFor({ cashControl: false, countedTotal: 0, expectedFloat: 'not a number' })).toBe('0.00');
    });

    it('emits cents, not a float that drifted', () => {
        // `countTotal` accumulates `value × quantity` in binary floating point, so a drawer of small
        // coins arrives here as 1.0000000000000002 and a mixed one as 43.699999999999996. Both are
        // well inside a cent — denominations have no sub-cent values, so no genuine half-cent input
        // exists — but the string that goes on the wire has to be money either way.
        expect(openingFloatFor({ cashControl: true, countedTotal: 0.05 * 20, expectedFloat: '0' })).toBe('1.00');
        expect(openingFloatFor({ cashControl: true, countedTotal: 0.1 + 0.2 + 43.4, expectedFloat: '0' })).toBe('43.70');
        expect(openingFloatFor({ cashControl: false, countedTotal: 0, expectedFloat: '99.9990' })).toBe('100.00');
    });
});
