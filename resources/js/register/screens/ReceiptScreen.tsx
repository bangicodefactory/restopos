import { toDescriptor } from '@domain/receipt/index';
import { useSessionStore } from '@shared/auth';
import { ReceiptView } from '@shared/printing';
import { Button } from '@shared/ui';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import { markPrinted } from '../domain/order-actions';
import { print } from '../domain/printing';
import { buildReceipt } from '../domain/receipt';
import { useCatalog, useOrder } from '../hooks/use-register';
import { useOrderStore } from '../state/order-store';

/**
 * The receipt screen (REG-240 … REG-247).
 *
 * The preview is the *same document* the printer receives, rendered from the same descriptor with
 * the same column layout helpers. That is what makes `window.print()` a usable fallback rather than
 * a second, differently-shaped receipt, and it is why the reprint of a six-month-old order still
 * looks like the original.
 *
 * E-mail and SMS are wired as disabled controls with an explanatory tooltip: the API contract lists
 * both as not implemented (spec 05 §15), and a button that silently does nothing is worse than one
 * that says why.
 */

export type ReceiptScreenProps = {
    orderUuid: string;
    onNewOrder: () => void;
    onBack: () => void;
};

export function ReceiptScreen({ orderUuid, onNewOrder, onBack }: ReceiptScreenProps): JSX.Element {
    const t = useT();
    const catalog = useCatalog();
    const order = useOrder(orderUuid);
    const cashier = useSessionStore((state) => state.cashier);
    const [status, setStatus] = useState<string | null>(null);
    const [autoPrinted, setAutoPrinted] = useState(false);

    const doc = useMemo(() => {
        const table =
            order?.restaurant_table_id != null ? catalog.tablesById.get(order.restaurant_table_id) : undefined;
        return buildReceipt(
            useOrderStore.getState(),
            orderUuid,
            {
                cashierName: cashier?.name ?? null,
                tableName: table?.table_number ?? null,
                copy: (order?.print_count ?? 0) + 1,
            },
            { openDrawer: false },
        );
    }, [cashier?.name, catalog, order, orderUuid]);

    const doPrint = async (): Promise<void> => {
        const runtime = tryRuntime();
        if (!runtime || !doc) return;
        setStatus(t('reg.receipt.printing'));
        const outcome = await print(runtime.printer, doc, { role: 'receipt' });
        markPrinted(orderUuid);
        setStatus(outcome.ok ? t('reg.receipt.printed') : t('reg.receipt.printFailed', { error: outcome.error.message }));
    };

    // REG-245 — auto-print on validation when the register is configured for it.
    useEffect(() => {
        if (autoPrinted || catalog.config?.iface_print_auto !== true) return;
        setAutoPrinted(true);
        void doPrint();
        // `doPrint` closes over the freshly built doc; re-running on every render would reprint.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoPrinted, catalog.config?.iface_print_auto]);

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 till:flex-row">
            <section className="min-h-0 flex-1 overflow-auto rounded-pos bg-slate-100 p-3">
                {doc ? <ReceiptView descriptor={toDescriptor(doc)} /> : <p>{t('reg.tickets.none')}</p>}
            </section>

            <aside className="w-full shrink-0 space-y-2 till:w-72">
                <h1 className="text-xl font-bold">{t('reg.receipt.title')}</h1>
                {status ? <p className="rounded-pos bg-slate-100 p-2 text-sm">{status}</p> : null}

                <Button size="xl" block onClick={() => void doPrint()}>
                    {(order?.print_count ?? 0) > 0 ? t('reg.receipt.reprint') : t('reg.receipt.print')}
                </Button>

                <Button block variant="secondary" disabled title={t('reg.receipt.notImplemented')}>
                    {t('reg.receipt.email')}
                </Button>
                <Button block variant="secondary" disabled title={t('reg.receipt.notImplemented')}>
                    {t('reg.receipt.sms')}
                </Button>
                <p className="text-xs text-slate-500">{t('reg.receipt.notImplemented')}</p>

                <Button size="xl" block variant="success" onClick={onNewOrder}>
                    {t('reg.receipt.newOrder')}
                </Button>
                <Button block variant="ghost" onClick={onBack}>
                    {t('reg.receipt.backToOrder')}
                </Button>
            </aside>
        </div>
    );
}
