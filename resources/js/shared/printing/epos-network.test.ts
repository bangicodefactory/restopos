/**
 * Addressing an ePOS printer (XCT-050, BAN-426).
 *
 * `devid` was hardcoded to `local_printer`. That is right for a single TM-i and wrong for a
 * multi-port unit, which exposes `local_printer2` and up — every binding pointed at the same unit
 * would queue every ticket on the first roll, and the kitchen's tickets would come out at the bar.
 * `epos_device_id` was declared on `PosPrinterRow` for exactly this and had no column to come from.
 */

import { describe, expect, it } from 'vitest';

import { EposNetworkTransport, eposServiceUrl } from './epos-network';
import type { PrinterBinding } from './types';

function binding(overrides: Partial<PrinterBinding> = {}): PrinterBinding {
    return {
        id: '1',
        name: 'Cuisine',
        role: 'prep',
        categoryIds: [],
        transport: 'epos',
        address: '192.168.1.52',
        profile: 'generic',
        enabled: true,
        status: { online: false, paper: 'unknown', cover: 'unknown', checkedAt: 0 },
        ...overrides,
    };
}

describe('eposServiceUrl', () => {
    it('defaults to local_printer, the only device a single TM-i exposes', () => {
        expect(eposServiceUrl('192.168.1.52')).toContain('devid=local_printer&');
    });

    it('addresses the port the binding names on a multi-port unit', () => {
        expect(eposServiceUrl('192.168.1.52', { deviceId: 'local_printer2' })).toContain('devid=local_printer2&');
    });

    it('escapes a device id rather than splicing it into the query string', () => {
        expect(eposServiceUrl('192.168.1.52', { deviceId: 'a&timeout=1' })).toContain('devid=a%26timeout%3D1&');
    });

    it('leaves an explicit devid in the address alone — an operator who typed one meant it', () => {
        const url = eposServiceUrl('http://192.168.1.52/cgi-bin/epos/service.cgi?devid=local_printer3', {
            deviceId: 'local_printer2',
        });

        expect(url).toContain('devid=local_printer3');
        expect(url).not.toContain('local_printer2');
    });
});

describe('EposNetworkTransport', () => {
    it("sends to the binding's device, not the transport's default", async () => {
        // One transport instance serves every ePOS printer on the LAN, so a devid held on the
        // transport would address them all alike — which is the bug, not the fix.
        const seen: string[] = [];
        const transport = new EposNetworkTransport({
            deviceId: 'local_printer',
            fetchImpl: (async (url: string) => {
                seen.push(String(url));
                return new Response('<response success="true" code="" status="0"/>', { status: 200 });
            }) as unknown as typeof fetch,
        });

        await transport.print({ nodes: [] } as never, binding({ eposDeviceId: 'local_printer2' }));

        expect(seen[0]).toContain('devid=local_printer2');
    });
});
