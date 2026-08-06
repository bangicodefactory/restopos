import type { ProductRow } from '@domain/types';
import { normalizeSearch } from '@shared/db';
import { useMediaUrl } from '@shared/media';
import { VirtualGrid, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo } from 'react';

import { tryRuntime } from '../data/runtime';

import { baseListPrice, categoryDescendants, type CatalogIndex } from '../data/catalog';
import { useT } from '../i18n';
import { useMoney } from '../hooks/use-register';
import { useUiStore } from '../state/ui-store';

/**
 * The product grid (REG-064, REG-068).
 *
 * Two things keep this smooth at 5 000 products on a cheap Android terminal:
 *
 *  1. **The catalog is not React state.** The frozen index is read here directly and the filtered
 *     list is memoised on `(catalog.version, categoryId, search)` — no store subscription, no
 *     structural-sharing pass, no re-render when an unrelated order changes.
 *  2. **`searchText` is precomputed at ingest.** A substring test over one folded, lowercased field
 *     is ~1 ms across the whole catalog; `toLocaleLowerCase()` per keystroke over raw fields is not,
 *     and that difference is the entire perceived speed of the register.
 */

export type ProductGridProps = {
    catalog: CatalogIndex;
    onPick: (product: ProductRow) => void;
    onLongPress?: (product: ProductRow) => void;
    /** Quantities already on the order, for the cart badge (REG-067). */
    cartQuantities?: Map<number, number>;
};

const ROW_HEIGHT = 112;
const MIN_COLUMN = 148;

export function ProductGrid({ catalog, onPick, onLongPress, cartQuantities }: ProductGridProps): JSX.Element {
    const t = useT();
    const money = useMoney();
    const categoryId = useUiStore((state) => state.categoryId);
    const search = useUiStore((state) => state.search);

    const products = useMemo(() => {
        const needle = normalizeSearch(search);

        if (needle !== '') {
            const prefix: ProductRow[] = [];
            const substring: ProductRow[] = [];
            for (const product of catalog.sellable) {
                const index = product.searchText.indexOf(needle);
                if (index === 0) prefix.push(product);
                else if (index > 0) substring.push(product);
                if (prefix.length >= 200) break;
            }
            return [...prefix, ...substring].slice(0, 300);
        }

        if (categoryId === null) return catalog.sellable;

        const ids = categoryDescendants(catalog, categoryId);
        const seen = new Set<number>();
        const out: ProductRow[] = [];
        for (const id of ids) {
            for (const product of catalog.productsByCategory.get(id) ?? []) {
                if (seen.has(product.id)) continue;
                seen.add(product.id);
                out.push(product);
            }
        }
        return out;
    }, [catalog, categoryId, search]);

    return (
        <VirtualGrid
            items={products}
            rowHeight={ROW_HEIGHT}
            minColumnWidth={MIN_COLUMN}
            gap={8}
            keyOf={(product) => product.id}
            className="min-h-0"
            empty={<p className="p-6 text-slate-500">{t('reg.products.none')}</p>}
            renderItem={(product) => (
                <ProductCard
                    product={product}
                    price={money(baseListPrice(catalog, catalog.defaultVariantByProduct.get(product.id)?.id ?? 0))}
                    quantity={cartQuantities?.get(product.id) ?? 0}
                    onPick={onPick}
                    {...(onLongPress ? { onLongPress } : {})}
                />
            )}
        />
    );
}

const COLORS = [
    'bg-white',
    'bg-amber-50',
    'bg-sky-50',
    'bg-emerald-50',
    'bg-rose-50',
    'bg-violet-50',
    'bg-lime-50',
    'bg-orange-50',
];

function ProductCard({
    product,
    price,
    quantity,
    onPick,
    onLongPress,
}: {
    product: ProductRow;
    price: string;
    quantity: number;
    onPick: (product: ProductRow) => void;
    onLongPress?: (product: ProductRow) => void;
}): JSX.Element {
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The bytes come from IndexedDB, not from an `<img src>` pointing at the route: the media route
    // is device-authenticated and an `<img>` cannot carry a bearer token (BAN-480).
    const runtime = tryRuntime();
    const image = useMediaUrl(runtime?.db ?? null, runtime?.api ?? null, product.image_media_id);

    return (
        <button
            type="button"
            onClick={() => onPick(product)}
            data-testid="product-tile"
            data-product-id={product.id}
            onPointerDown={() => {
                if (!onLongPress) return;
                timer = setTimeout(() => onLongPress(product), 550);
            }}
            onPointerUp={() => {
                if (timer !== null) clearTimeout(timer);
            }}
            onPointerLeave={() => {
                if (timer !== null) clearTimeout(timer);
            }}
            onContextMenu={(event) => {
                if (!onLongPress) return;
                event.preventDefault();
                onLongPress(product);
            }}
            className={cn(
                'relative flex h-full w-full flex-col justify-between rounded-pos p-2 text-left shadow-pos ring-1 ring-slate-200',
                'active:shadow-press-inset',
                COLORS[product.color % COLORS.length],
            )}
        >
            {image !== null ? (
                <>
                    <img
                        src={image}
                        alt=""
                        aria-hidden
                        // Decorative: the product name is right there in text, so a screen reader
                        // announcing the picture as well would just say everything twice.
                        className="absolute inset-0 h-full w-full rounded-pos object-cover"
                        loading="lazy"
                    />
                    {/*
                      * A scrim, not a faded photo. The tile has to do two jobs at once — be
                      * recognisable at a glance and stay readable — and washing the image out to a
                      * quarter serves neither: too faint to identify, still enough to fight the
                      * text. A dark gradient under the label keeps the name legible against any
                      * photo while the image itself stays fully visible above it.
                      */}
                    <span
                        aria-hidden
                        className="absolute inset-0 rounded-pos bg-gradient-to-t from-black/70 via-black/25 to-transparent"
                    />
                </>
            ) : null}
            <span
                data-testid="product-name"
                className={cn(
                    'relative line-clamp-3 text-sm font-semibold leading-tight',
                    image !== null ? 'text-white drop-shadow' : 'text-slate-900',
                )}
            >
                {product.name}
            </span>
            <span
                className={cn(
                    'relative text-base font-bold',
                    image !== null ? 'text-white drop-shadow' : 'text-slate-700',
                )}
            >
                {price}
            </span>
            {quantity > 0 ? (
                <span className="absolute right-1 top-1 min-w-6 rounded-full bg-brand-600 px-1.5 text-center text-xs font-bold text-white">
                    {quantity}
                </span>
            ) : null}
            {product.is_favorite ? (
                <span className="absolute left-1 top-1 text-xs" aria-hidden>
                    ★
                </span>
            ) : null}
        </button>
    );
}
