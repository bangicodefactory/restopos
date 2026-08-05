import { describe, expect, it } from 'vitest';

import { needsKitchenPromptBeforePay } from './OrderPanel';

/**
 * RST-143 — Pay must ask before settling an order the kitchen has not been told about.
 *
 * The failure it prevents is quiet and expensive: the cashier takes the money, the order is marked
 * paid, and the unsent items are simply never cooked. Nothing errors; the table just waits.
 */
describe('needsKitchenPromptBeforePay', () => {
    it('prompts when a restaurant order has unsent kitchen changes', () => {
        expect(needsKitchenPromptBeforePay({ restaurant: true, unsent: 1 })).toBe(true);
        expect(needsKitchenPromptBeforePay({ restaurant: true, unsent: 7 })).toBe(true);
    });

    it('goes straight to payment when the delta is empty', () => {
        expect(needsKitchenPromptBeforePay({ restaurant: true, unsent: 0 })).toBe(false);
    });

    it('never prompts outside restaurant mode — a counter sale has no kitchen step to skip', () => {
        expect(needsKitchenPromptBeforePay({ restaurant: false, unsent: 5 })).toBe(false);
        expect(needsKitchenPromptBeforePay({ restaurant: false, unsent: 0 })).toBe(false);
    });
});
