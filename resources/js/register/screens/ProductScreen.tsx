import type { ProductRow } from '@domain/types';
import { Button, SearchInput, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo } from 'react';

import { CategoryRail } from '../components/CategoryRail';
import { NumpadPanel } from '../components/NumpadPanel';
import { OrderPanel } from '../components/OrderPanel';
import { OrderTabs } from '../components/OrderTabs';
import { ProductGrid } from '../components/ProductGrid';
import { useT } from '../i18n';
import { addLine, createOrder, setDiscount } from '../domain/order-actions';
import { lineUuidsOf } from '../state/order-store';
import { startAdd } from '../domain/product-flow';
import { attachScanner, routeScan } from '../domain/scanner';
import { orderSnapshot, useCatalog, useOrderLines, useSelectedOrderUuid } from '../hooks/use-register';
import { useUiStore } from '../state/ui-store';

/**
 * The register's home screen.
 *
 * Layout is two panes on a till (order left, catalog right) and one pane at a time on a phone, with
 * a switcher — the same components, no second implementation. The scanner is attached here rather
 * than globally so it is live exactly where a scan means "add a product", and it routes through
 * `@domain/barcode` so an embedded-weight label sets the quantity instead of being read as a
 * thirteen-digit product code.
 */

export type ProductScreenProps = {
    onPay: () => void;
    /** REG-209 — a fast-payment tap settled the order; go to the receipt. */
    onFastPaid: () => void;
    onSend: () => void;
    onFireCourse: (courseUuid: string) => void;
    onBill: () => void;
    onSplit: () => void;
    onTransfer: () => void;
};

export function ProductScreen({
    onPay,
    onFastPaid,
    onSend,
    onFireCourse,
    onBill,
    onSplit,
    onTransfer,
}: ProductScreenProps): JSX.Element {
    const t = useT();
    const catalog = useCatalog();
    const orderUuid = useSelectedOrderUuid();
    const lines = useOrderLines(orderUuid);
    const search = useUiStore((state) => state.search);
    const setSearch = useUiStore((state) => state.setSearch);
    const pane = useUiStore((state) => state.pane);
    const setPane = useUiStore((state) => state.setPane);
    const openDialog = useUiStore((state) => state.openDialog);
    const noteScan = useUiStore((state) => state.noteScan);

    // An order must exist before a product can be tapped; creating it lazily keeps the reference
    // counter from burning a number every time the screen mounts.
    const ensureOrder = useCallback(async (): Promise<string> => {
        const current = useUiStore.getState();
        void current;
        return orderUuid ?? (await createOrder());
    }, [orderUuid]);

    const onPick = useCallback(
        (product: ProductRow) => {
            void ensureOrder().then((uuid) => startAdd(product, uuid));
        },
        [ensureOrder],
    );

    const onLongPress = useCallback(
        (product: ProductRow) => openDialog('productInfo', { productId: product.id }),
        [openDialog],
    );

    const onScan = useCallback(
        (code: string) => {
            noteScan();
            const action = routeScan(code, catalog);
            void ensureOrder().then((uuid) => {
                switch (action.kind) {
                    case 'product':
                        addLine({ orderUuid: uuid, variantId: action.variant.id, quantity: action.quantity });
                        break;
                    case 'weighed':
                        addLine({
                            orderUuid: uuid,
                            variantId: action.variant.id,
                            quantity: action.quantity,
                            skipMerge: true,
                        });
                        break;
                    case 'priced':
                        addLine({
                            orderUuid: uuid,
                            variantId: action.variant.id,
                            quantity: 1,
                            priceUnit: action.price,
                            priceType: 'manual',
                            skipMerge: true,
                        });
                        break;
                    case 'customer':
                        openDialog('customer', { barcode: action.code });
                        break;
                    case 'discount': {
                        // REG-083 — a discount barcode applies to the selected line, or to every
                        // line on the order when nothing is selected (Odoo's whole-order behaviour).
                        const snapshot = orderSnapshot();
                        const targets = snapshot.selectedLineUuid
                            ? [snapshot.selectedLineUuid]
                            : lineUuidsOf(snapshot, uuid);
                        for (const lineUuid of targets) setDiscount(lineUuid, action.percent);
                        break;
                    }
                    case 'cashier':
                    case 'unknown':
                    default:
                        // REG-089 — never a dead end: drop the code into the search box so the
                        // cashier can look it up or create the product.
                        setSearch(action.code);
                        break;
                }
            });
        },
        [catalog, ensureOrder, noteScan, openDialog, setSearch],
    );

    useEffect(() => attachScanner({ onScan }), [onScan]);

    const cartQuantities = useMemo(() => {
        const out = new Map<number, number>();
        for (const line of lines) out.set(line.product_id, (out.get(line.product_id) ?? 0) + line.quantity);
        return out;
    }, [lines]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <OrderTabs />

            <div className="flex min-h-0 flex-1">
                <OrderPanel
                    orderUuid={orderUuid}
                    onPay={onPay}
                    onFastPaid={onFastPaid}
                    onSend={onSend}
                    onFireCourse={onFireCourse}
                    onBill={onBill}
                    onSplit={onSplit}
                    onTransfer={onTransfer}
                    className={cn(
                        'w-full border-e border-slate-200 till:w-[26rem] till:shrink-0',
                        pane === 'catalog' && 'hidden till:flex',
                    )}
                />

                <section
                    className={cn(
                        'flex min-h-0 w-full flex-1 flex-col gap-2 p-2',
                        pane === 'order' && 'hidden till:flex',
                    )}
                    aria-label={t('reg.nav.products')}
                >
                    <SearchInput
                        value={search}
                        onChange={setSearch}
                        placeholder={t('reg.products.search')}
                        aria-label={t('reg.products.search')}
                        data-scanner-passthrough="true"
                    />
                    <CategoryRail catalog={catalog} />
                    <ProductGrid
                        catalog={catalog}
                        onPick={onPick}
                        onLongPress={onLongPress}
                        cartQuantities={cartQuantities}
                    />
                </section>

                <aside className="hidden w-64 shrink-0 border-s border-slate-200 p-2 till:block">
                    <NumpadPanel />
                </aside>
            </div>

            <div className="flex gap-2 border-t border-slate-200 p-2 till:hidden">
                <Button
                    className="flex-1"
                    variant={pane === 'order' ? 'primary' : 'secondary'}
                    onClick={() => setPane('order')}
                >
                    {t('reg.nav.order')} ({lines.length})
                </Button>
                <Button
                    className="flex-1"
                    variant={pane === 'catalog' ? 'primary' : 'secondary'}
                    onClick={() => setPane('catalog')}
                >
                    {t('reg.nav.products')}
                </Button>
            </div>
        </div>
    );
}
