import { describe, expect, it } from 'vitest';

import { REGISTER_ONLINE_ONLY, availableOffline, requiresConnection, type RegisterOperation } from './online-only';

describe('register online-only operations', () => {
    it('requires a connection for every declared operation', () => {
        for (const operation of REGISTER_ONLINE_ONLY) expect(requiresConnection(operation)).toBe(true);
    });

    it('keeps the shift working offline', () => {
        // If any of these ever became online-only the till would stop selling in a Wi-Fi dropout,
        // which is the one thing the offline-first design exists to prevent.
        const offline: RegisterOperation[] = [
            'ring-up',
            'tender',
            'print-receipt',
            'send-to-kitchen',
            'split-bill',
            'manager-override',
        ];

        for (const operation of offline) expect(availableOffline(operation)).toBe(true);
    });

    it('keeps adding a customer available offline', () => {
        // Deliberate, and a departure from Odoo: a walk-in asking for a receipt in their name must
        // not depend on the venue's Wi-Fi.
        expect(availableOffline('add-customer')).toBe(true);
    });

    it('will not let a session be opened or closed on a local guess', () => {
        // Closing totals are computed server-side from synced orders. Inventing them offline is
        // inventing money.
        expect(requiresConnection('open-session')).toBe(true);
        expect(requiresConnection('close-session')).toBe(true);
    });

    it('is the inverse of availableOffline for every operation', () => {
        const all: RegisterOperation[] = [
            ...REGISTER_ONLINE_ONLY,
            'ring-up',
            'tender',
            'print-receipt',
            'send-to-kitchen',
            'split-bill',
            'add-customer',
            'manager-override',
        ];

        for (const operation of all) expect(availableOffline(operation)).toBe(!requiresConnection(operation));
    });
});
