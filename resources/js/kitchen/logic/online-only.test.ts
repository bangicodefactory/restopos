import { describe, expect, it } from 'vitest';

import { KITCHEN_ONLINE_ONLY, availableOffline, requiresConnection } from './online-only';

describe('kitchen online-only list (BAN-450)', () => {
    it('marks device/setup operations online-only', () => {
        expect(requiresConnection('pair')).toBe(true);
        expect(requiresConnection('choose-display')).toBe(true);
        expect(requiresConnection('unpair')).toBe(true);
    });

    it('lets board interactions run offline — they queue and replay', () => {
        expect(availableOffline('advance-stage')).toBe(true);
        expect(availableOffline('recall')).toBe(true);
        expect(availableOffline('toggle-line')).toBe(true);
    });

    it('every declared entry requires a connection', () => {
        for (const op of KITCHEN_ONLINE_ONLY) expect(requiresConnection(op)).toBe(true);
    });
});
