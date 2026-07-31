import { generateUuid } from '@domain/sequence/index';
import type { CustomerRow } from '@domain/types';
import { normalizeSearch, phoneDigitsOf, searchCustomers } from '@shared/db';
import { Button, Dialog, SearchInput, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { tryRuntime } from '../../data/runtime';
import { useT } from '../../i18n';
import { applyCustomerDefaults, setCustomer } from '../../domain/order-actions';
import { useOrder, useOrderLines, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

/**
 * Customer picker, inline create and edit (REG-150 … REG-155).
 *
 * The contract marks customer create/update from the register as not implemented server-side, so a
 * created customer is written to the local replica and queued as a `partner.create` command. That
 * is a deliberate improvement over Odoo's "you must be online to add a customer" — a walk-in asking
 * for an invoice at 8pm on a dead uplink is a real situation — and it is honest about the trade:
 * the row carries a client uuid and reconciles when the endpoint exists.
 */

export function CustomerDialog(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const orderUuid = useSelectedOrderUuid();
    const order = useOrder(orderUuid);
    const lines = useOrderLines(orderUuid);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<CustomerRow[]>([]);
    const [editing, setEditing] = useState<Partial<CustomerRow> | null>(null);
    const [error, setError] = useState<string | null>(null);

    const search = useCallback(async (value: string) => {
        const runtime = tryRuntime();
        if (!runtime) return;
        if (value.trim() === '') {
            setResults(await runtime.db.customers.orderBy('order_count').reverse().limit(30).toArray());
            return;
        }
        setResults(await searchCustomers(runtime.db, value, 40));
    }, []);

    useEffect(() => {
        if (dialog?.kind !== 'customer') return;
        void search(query);
    }, [dialog?.kind, query, search]);

    if (dialog?.kind !== 'customer' || orderUuid === null) return null;

    // REG-158 — a refund order's customer is frozen.
    const locked = order?.is_refund === true || lines.some((line) => line.refunded_line_uuid !== null);

    const choose = (customer: CustomerRow): void => {
        setCustomer(orderUuid, customer.id);
        applyCustomerDefaults(orderUuid, {
            pricelist_id: customer.pricelist_id,
            fiscal_position_id: customer.fiscal_position_id,
        });
        close();
    };

    const save = async (): Promise<void> => {
        const runtime = tryRuntime();
        if (!runtime || !editing) return;
        if (!editing.name || editing.name.trim() === '') {
            setError(t('reg.customer.nameRequired'));
            return;
        }

        const uuid = editing.uuid ?? generateUuid();
        // Negative ids keep locally-created customers from colliding with server ids until the
        // reconciliation endpoint exists.
        const id = editing.id ?? -Date.now();
        const row: CustomerRow = {
            id,
            uuid,
            name: editing.name,
            company_name: editing.company_name ?? null,
            email: editing.email ?? null,
            phone: editing.phone ?? null,
            mobile: editing.mobile ?? null,
            vat: editing.vat ?? null,
            street: editing.street ?? null,
            city: editing.city ?? null,
            zip: editing.zip ?? null,
            country_id: null,
            state_id: null,
            barcode: null,
            pricelist_id: editing.pricelist_id ?? null,
            fiscal_position_id: editing.fiscal_position_id ?? null,
            loyalty_card_ids: [],
            order_count: editing.order_count ?? 0,
            updated_at: new Date().toISOString(),
            searchText: normalizeSearch(
                [editing.name, editing.company_name, editing.email, editing.vat].filter(Boolean).join(' '),
            ),
            phoneDigits: phoneDigitsOf(editing.phone, editing.mobile),
        };

        await runtime.db.customers.put(row);
        await runtime.syncer.enqueueCommand('partner.create', row);
        setEditing(null);
        choose(row);
    };

    if (editing) {
        return (
            <Dialog
                open
                onClose={() => setEditing(null)}
                title={editing.id ? t('reg.customer.edit') : t('reg.customer.create')}
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setEditing(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button onClick={() => void save()}>{t('common.ok')}</Button>
                    </>
                }
            >
                <div className="grid gap-3">
                    {(
                        [
                            ['name', t('reg.customer.name')],
                            ['phone', t('reg.customer.phone')],
                            ['email', t('reg.customer.email')],
                            ['vat', t('reg.customer.vat')],
                            ['street', t('reg.customer.street')],
                            ['zip', t('reg.customer.zip')],
                            ['city', t('reg.customer.city')],
                        ] as const
                    ).map(([field, label]) => (
                        <label key={field} className="grid gap-1">
                            <span className="text-sm font-semibold">{label}</span>
                            <input
                                type="text"
                                className="min-h-touch-lg rounded-pos border border-slate-300 px-3"
                                value={(editing[field] as string | null | undefined) ?? ''}
                                onChange={(event) =>
                                    setEditing((current) => ({ ...current, [field]: event.target.value }))
                                }
                            />
                        </label>
                    ))}
                    {error ? <p className="text-danger">{error}</p> : null}
                </div>
            </Dialog>
        );
    }

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.customer.title')}
            size="lg"
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.close')}
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={locked}
                        onClick={() => {
                            setCustomer(orderUuid, null);
                            close();
                        }}
                    >
                        {t('reg.customer.remove')}
                    </Button>
                    <Button disabled={locked} onClick={() => setEditing({})}>
                        {t('reg.customer.create')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder={t('reg.customer.search')}
                    aria-label={t('reg.customer.search')}
                />

                {locked ? <p className="text-warn-fg">{t('reg.customer.refundLock')}</p> : null}

                <ul className="divide-y divide-slate-200">
                    {results.map((customer) => (
                        <li key={customer.id} className="flex items-center gap-2 py-2">
                            <button
                                type="button"
                                disabled={locked}
                                className={cn('min-h-touch-lg flex-1 text-start', locked && 'opacity-50')}
                                onClick={() => choose(customer)}
                            >
                                <span className="block font-semibold">{customer.name}</span>
                                <span className="block text-sm text-slate-600">
                                    {[customer.phone, customer.email, customer.city].filter(Boolean).join(' · ')}
                                </span>
                            </button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(customer)}>
                                {t('reg.customer.edit')}
                            </Button>
                        </li>
                    ))}
                </ul>

                {/* Loyalty is a stored-but-ignored flag server-side; the placeholder says so rather
                    than pretending to have points. */}
                <p className="rounded-pos bg-slate-100 p-3 text-sm text-slate-600">
                    {t('reg.customer.loyalty')}: {t('reg.customer.loyaltySoon')}
                </p>
            </div>
        </Dialog>
    );
}
