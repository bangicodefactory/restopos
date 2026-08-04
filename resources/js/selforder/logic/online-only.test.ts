import { describe, expect, it } from 'vitest';

import { SELF_ORDER_ONLINE_ONLY, availableOffline, requiresConnection } from './online-only';

describe('self-order online-only list (BAN-450)', () => {
    it('marks send / pay / cancel online-only', () => {
        expect(requiresConnection('submit')).toBe(true);
        expect(requiresConnection('pay-online')).toBe(true);
        expect(requiresConnection('cancel-order')).toBe(true);
    });

    it('lets browsing and cart editing run offline', () => {
        expect(availableOffline('browse-menu')).toBe(true);
        expect(availableOffline('edit-cart')).toBe(true);
    });

    it('every declared entry requires a connection', () => {
        for (const op of SELF_ORDER_ONLINE_ONLY) expect(requiresConnection(op)).toBe(true);
    });
});
