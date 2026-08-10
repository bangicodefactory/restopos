import { describe, expect, it } from 'vitest';

import { PrinterRouter } from './router';
import { UNKNOWN_STATUS } from './types';
import type { PrinterBinding, PrintJob, PrinterRole } from './types';

/**
 * BAN-438 — where a session reading comes out.
 *
 * `PrinterRole` has carried `'report'` since the printing contract was written and nothing had ever
 * produced one, so the fallback rule was never exercised: `resolveTargets` returned the printers
 * matching the role exactly, and an empty list means the job is **dropped**. Almost no venue binds
 * a separate back-office printer, so the X-report button would have been a button that silently
 * did nothing.
 */

function binding(id: string, role: PrinterRole, enabled = true): PrinterBinding {
    return {
        id,
        name: id,
        role,
        categoryIds: [],
        transport: 'epos',
        address: '10.0.0.1',
        profile: 'generic',
        enabled,
        status: UNKNOWN_STATUS,
    };
}

function router(bindings: PrinterBinding[]): PrinterRouter {
    return new PrinterRouter({ bindings, transports: {} as never });
}

const reportJob = { id: 'j1', role: 'report' } as unknown as PrintJob;

describe('report routing', () => {
    it('prefers a printer bound for reports', () => {
        const targets = router([binding('receipt-1', 'receipt'), binding('back-office', 'report')])
            .resolveTargets(reportJob);

        expect(targets.map((b) => b.id)).toEqual(['back-office']);
    });

    it('falls back to the receipt printer when none is bound', () => {
        // The common case by far, and the one that used to drop the job.
        const targets = router([binding('receipt-1', 'receipt')]).resolveTargets(reportJob);

        expect(targets.map((b) => b.id)).toEqual(['receipt-1']);
    });

    it('ignores a disabled report printer rather than dropping the job on it', () => {
        const targets = router([binding('back-office', 'report', false), binding('receipt-1', 'receipt')])
            .resolveTargets(reportJob);

        expect(targets.map((b) => b.id)).toEqual(['receipt-1']);
    });

    it('still resolves nowhere when the till has no printer at all', () => {
        // Not every till has one, and inventing a target would fail later and less clearly.
        expect(router([]).resolveTargets(reportJob)).toEqual([]);
    });

    it('leaves the other roles alone', () => {
        const label = { id: 'j2', role: 'label' } as unknown as PrintJob;

        expect(router([binding('receipt-1', 'receipt')]).resolveTargets(label)).toEqual([]);
    });
});
