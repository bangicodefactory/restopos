import type { ProductRow } from '@domain/types';
import { Button, SearchInput, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CategoryRail } from '../components/CategoryRail';
import { NumpadPanel } from '../components/NumpadPanel';
import { OrderPanel } from '../components/OrderPanel';
import { OrderTabs } from '../components/OrderTabs';
import { ProductGrid } from '../components/ProductGrid';
import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import {
    attachBarcodeSource,
    browserCameraSource,
    detectCapabilities,
    hidBarcodeSource,
    selectBarcodeSource,
} from '../domain/barcode-source';
import { addLine, createOrder, setDiscount } from '../domain/order-actions';
import { lineUuidsOf } from '../state/order-store';
import { startAdd } from '../domain/product-flow';
import { resolveScanMiss } from '../domain/scan-miss';
import { routeScan, type ScanAction } from '../domain/scanner';
import { orderSnapshot, useCatalog, useOrderLines, useSelectedOrderUuid } from '../hooks/use-register';
import { useSyncStore } from '../state/boot-store';
import { useUiStore } from '../state/ui-store';

/**
 * The register's home screen.
 *
 * Layout is two panes on a till (order left, catalog right) and one pane at a time on a phone, with
 * a switcher — the same components, no second implementation. The scanner is attached here rather
 * than globally so it is live exactly where a scan means "add a product", and it routes through
 * `@domain/barcode` so an embedded-weight label sets the quantity instead of being read as a
 * thirteen-digit product code.
 *
 * Scanning has two halves that meet at exactly one point. The **source** (wedge or camera,
 * `domain/barcode-source.ts`) produces a string; `routeScan` decides what it means; a miss goes to
 * `resolveScanMiss`, which asks the server and re-routes. Adding a source adds no parsing and no
 * miss handling — that is the whole reason the seam is a string.
 */

export type ProductScreenProps = {
    onPay: () => void;
    /** REG-209 — a fast-payment tap settled the order; go to the receipt. */
    onFastPaid: () => void;
    onSend: () => void;
    onFireCourse: (courseUuid: string) => void;
    /** KDS-059 — put the last kitchen ticket on paper again, without re-firing the pass. */
    onReprintPrep: () => void;
    onBill: () => void;
    onSplit: () => void;
    onTransfer: () => void;
};

export function ProductScreen({
    onPay,
    onFastPaid,
    onSend,
    onFireCourse,
    onReprintPrep,
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
    const scannerSource = useUiStore((state) => state.scannerSource);
    const setScannerSource = useUiStore((state) => state.setScannerSource);
    const pushNotice = useSyncStore((state) => state.pushNotice);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    // Read once: the answer cannot change while the screen is mounted, and calling it during render
    // would make the effect below re-run on every keystroke.
    const [capabilities] = useState(() => detectCapabilities());
    const effectiveSource = selectBarcodeSource(scannerSource, capabilities);

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

    const applyScan = useCallback(
        (action: ScanAction, uuid: string) => {
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
        },
        [openDialog, setSearch],
    );

    const onScan = useCallback(
        (code: string) => {
            noteScan();
            const action = routeScan(code, catalog);

            void ensureOrder().then(async (uuid) => {
                if (action.kind !== 'unknown') {
                    applyScan(action, uuid);
                    return;
                }

                // REG-071 — the catalogue here is a *capped* slice of the venue's, so a miss is not
                // an answer yet. Ask the server before saying anything to the cashier.
                const runtime = tryRuntime();
                const outcome = runtime
                    ? await resolveScanMiss(code, action, { api: runtime.api, db: runtime.db })
                    : ({ kind: 'notFound', code: action.code } as const);

                if (outcome.kind === 'resolved') {
                    applyScan(outcome.action, uuid);
                    return;
                }

                // Still never a dead end (REG-089) — but no longer *silent*, which was the actual
                // user-facing bug: filling the search box and saying nothing left "not stocked here",
                // "does not exist" and "the wifi is down" looking identical.
                setSearch(outcome.code);
                pushNotice({
                    orderUuid: uuid,
                    message:
                        outcome.kind === 'offline'
                            ? t('reg.products.scanOffline')
                            : t('reg.products.unknownBarcode', { code: outcome.code }),
                });
            });
        },
        [applyScan, catalog, ensureOrder, noteScan, pushNotice, setSearch, t],
    );

    useEffect(() => {
        const source =
            effectiveSource === 'camera' ? browserCameraSource(() => videoRef.current) : hidBarcodeSource();

        // `attachBarcodeSource` owns the release, including the case where the screen is left before
        // the camera finishes opening (REG-081 requires the stream be released on exit).
        return attachBarcodeSource(source, onScan);
    }, [effectiveSource, onScan]);

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
                    onReprintPrep={onReprintPrep}
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
                    <div className="flex items-center gap-2">
                        <SearchInput
                            className="flex-1"
                            value={search}
                            onChange={setSearch}
                            placeholder={t('reg.products.search')}
                            aria-label={t('reg.products.search')}
                            data-scanner-passthrough="true"
                        />
                        {capabilities.camera ? (
                            <Button
                                data-testid="scanner-source"
                                data-scanner-source={effectiveSource}
                                variant={effectiveSource === 'camera' ? 'primary' : 'secondary'}
                                aria-pressed={effectiveSource === 'camera'}
                                onClick={() => setScannerSource(effectiveSource === 'camera' ? 'hid' : 'camera')}
                            >
                                {t('reg.products.scanCamera')}
                            </Button>
                        ) : null}
                    </div>

                    {effectiveSource === 'camera' ? (
                        <video
                            ref={videoRef}
                            data-testid="scanner-preview"
                            className="h-32 w-full rounded-pos bg-slate-900 object-cover"
                            aria-label={t('reg.products.scanCameraPreview')}
                            muted
                            playsInline
                        />
                    ) : null}

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
