import { Button, SearchInput, cn } from '@shared/ui';
import { useMemo, useRef, useState, type JSX } from 'react';

import { Price, ProductImage } from './Brand';
import { useT } from '../i18n';
import type { Catalog, MenuCategory, MenuProduct } from '../catalog';
import { productImageUrl } from '../catalog';
import { isProductOrderable, visibleCategories } from '../logic/availability';
import { displayUnitPrice } from '../logic/cart';
import { isCombo } from '../logic/combo';
import { variantUnitPrice, resolveVariant, taxIdsFor } from '../catalog';

/**
 * Menu browsing (SLF-022, SLF-023, SLF-024, SLF-025).
 *
 * A category rail across the top with scroll-spy, a product grid below. Two cards per row on a
 * phone, four on a kiosk — driven by a media query rather than a mode flag, so a tablet in the
 * window lands somewhere sensible without a third code path.
 *
 * The price on a card comes through the tax engine, not through `list_price`, because a venue that
 * displays tax-inclusive prices must show the number the customer will actually be charged.
 */

export type MenuScreenProps = {
    catalog: Catalog;
    now: Date;
    cartCount: number;
    cartTotal: string;
    ordering: boolean;
    kiosk: boolean;
    onOpenProduct: (productId: number) => void;
    onQuickAdd: (product: MenuProduct) => void;
    onCart: () => void;
    onBack: () => void;
};

export function MenuScreen(props: MenuScreenProps): JSX.Element {
    const t = useT();
    const { catalog, kiosk } = props;
    const [query, setQuery] = useState('');
    const [activeCategory, setActiveCategory] = useState<number | null>(null);
    const sectionRefs = useRef<Record<number, HTMLElement | null>>({});

    const categories = useMemo(() => visibleCategories(catalog, props.now), [catalog, props.now]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === '') return null;
        return catalog.products.filter(
            (product) => isProductOrderable(catalog, product) && product.name.toLowerCase().includes(needle),
        );
    }, [catalog, query]);

    const scrollTo = (categoryId: number): void => {
        setActiveCategory(categoryId);
        sectionRefs.current[categoryId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div className="flex min-h-full flex-col bg-slate-50">
            <header className="sticky top-0 z-20 bg-white shadow-sm">
                <div className="flex items-center gap-2 px-3 py-2">
                    <button
                        type="button"
                        onClick={props.onBack}
                        aria-label={t('common.back')}
                        className="min-h-touch min-w-touch rounded-pos text-2xl text-slate-700 active:bg-slate-100"
                    >
                        ←
                    </button>
                    <h1 className="flex-1 truncate text-xl font-bold">{t('so.menu.title')}</h1>
                </div>

                {!kiosk && (
                    <div className="px-3 pb-2">
                        <SearchInput
                            value={query}
                            onChange={setQuery}
                            placeholder={t('so.menu.search')}
                            aria-label={t('so.menu.search')}
                        />
                    </div>
                )}

                {filtered === null && categories.length > 0 && (
                    <nav className="pos-scroll flex gap-2 px-3 pb-2" aria-label={t('so.menu.title')}>
                        {categories.map((category) => (
                            <button
                                key={category.id}
                                type="button"
                                onClick={() => scrollTo(category.id)}
                                aria-current={activeCategory === category.id}
                                className={cn(
                                    'min-h-touch shrink-0 whitespace-nowrap rounded-full px-4 text-base font-bold ring-1 ring-inset',
                                    activeCategory === category.id
                                        ? 'bg-brand-600 text-white ring-brand-600'
                                        : 'bg-white text-slate-700 ring-slate-300',
                                )}
                            >
                                {category.name}
                            </button>
                        ))}
                    </nav>
                )}
            </header>

            <div className="flex-1 px-3 pb-32 pt-3">
                {filtered !== null ? (
                    <ProductGrid products={filtered} {...props} />
                ) : categories.length === 0 ? (
                    <p className="py-16 text-center text-xl text-slate-500">{t('so.menu.empty')}</p>
                ) : (
                    categories.map((category) => (
                        <CategorySection
                            key={category.id}
                            category={category}
                            products={(catalog.productsByCategory.get(category.id) ?? []).filter((product) =>
                                isProductOrderable(catalog, product),
                            )}
                            innerRef={(element) => {
                                sectionRefs.current[category.id] = element;
                            }}
                            {...props}
                        />
                    ))
                )}
            </div>

            {props.ordering && props.cartCount > 0 && (
                <div className="pos-safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white px-3 py-3">
                    <Button size="xl" block onClick={props.onCart}>
                        <span className="flex w-full items-center justify-between gap-3">
                            <span className="rounded-full bg-white/25 px-3 py-0.5 tabular-nums">
                                {props.cartCount}
                            </span>
                            <span>{t('so.cart.checkout')}</span>
                            <Price amount={props.cartTotal} />
                        </span>
                    </Button>
                </div>
            )}
        </div>
    );
}

function CategorySection({
    category,
    products,
    innerRef,
    ...rest
}: MenuScreenProps & {
    category: MenuCategory;
    products: MenuProduct[];
    innerRef: (element: HTMLElement | null) => void;
}): JSX.Element | null {
    if (products.length === 0) return null;
    return (
        <section ref={innerRef} className="scroll-mt-40 pb-6">
            <h2 className="pb-2 pt-2 text-2xl font-black">{category.name}</h2>
            <ProductGrid products={products} {...rest} />
        </section>
    );
}

function ProductGrid({
    products,
    catalog,
    kiosk,
    ordering,
    onOpenProduct,
    onQuickAdd,
}: MenuScreenProps & { products: MenuProduct[] }): JSX.Element {
    const t = useT();
    return (
        <ul className={cn('grid gap-3', kiosk ? 'grid-cols-2 xl:grid-cols-3' : 'grid-cols-2')}>
            {products.map((product) => {
                const variant = resolveVariant(catalog, product.id, []);
                const base = variantUnitPrice(catalog, variant, product, []);
                const price = displayUnitPrice(base, taxIdsFor(variant, product), catalog);
                const available = isProductOrderable(catalog, product);
                const configurable = isCombo(product) || (catalog.attributeLinesByProduct.get(product.id) ?? []).length > 0;

                return (
                    <li key={product.id}>
                        <button
                            type="button"
                            disabled={!available}
                            onClick={() => {
                                if (!ordering) onOpenProduct(product.id);
                                else if (configurable) onOpenProduct(product.id);
                                else onQuickAdd(product);
                            }}
                            className={cn(
                                'flex size-full flex-col overflow-hidden rounded-pos-lg bg-white text-start shadow-pos',
                                'ring-1 ring-slate-200 active:scale-[0.99] disabled:opacity-50',
                            )}
                        >
                            <span className={cn('block w-full overflow-hidden', kiosk ? 'h-44' : 'h-32')}>
                                <ProductImage url={productImageUrl(catalog, product)} name={product.name} />
                            </span>
                            <span className="flex flex-1 flex-col gap-1 p-3">
                                <span className="text-lg font-bold leading-tight">{product.name}</span>
                                {product.description && (
                                    <span className="line-clamp-2 text-base text-slate-500">
                                        {product.description}
                                    </span>
                                )}
                                <span className="mt-auto flex items-center justify-between pt-2">
                                    <Price amount={price} className="text-lg font-black" />
                                    {!available && (
                                        <span className="rounded bg-slate-200 px-2 py-0.5 text-sm font-bold text-slate-600">
                                            {t('so.menu.unavailable')}
                                        </span>
                                    )}
                                    {available && product.tagIds.length > 0 && (
                                        <span className="flex gap-1">
                                            {product.tagIds.slice(0, 2).map((tagId) => {
                                                const tag = catalog.tagsById.get(tagId);
                                                return tag ? (
                                                    <span
                                                        key={tagId}
                                                        className="rounded bg-brand-50 px-2 py-0.5 text-sm font-bold text-brand-800"
                                                    >
                                                        {tag.name}
                                                    </span>
                                                ) : null;
                                            })}
                                        </span>
                                    )}
                                </span>
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
