import type { Catalog, MenuCategory, MenuProduct } from '../catalog';
import type { SelfOrderConfig } from '../types';

/**
 * What a customer may see and order right now (SLF-002, SLF-015, SLF-023, SLF-025).
 *
 * Ordering is gated in three independent places and all three matter:
 *   - the **mode** (`consultation` can browse but never order — and the API enforces it, so this is
 *     a UI courtesy, not the control);
 *   - the **session** (`ordering_open` is false when the venue has no open session: the menu still
 *     renders, only the buttons go away);
 *   - the **item** (`self_order_available`, plus its category's time window).
 */

export function canOrder(config: SelfOrderConfig): boolean {
    if (config.mode !== 'mobile' && config.mode !== 'kiosk') return false;
    return config.ordering_open;
}

export function isConsultation(config: SelfOrderConfig): boolean {
    return config.mode === 'consultation' || config.mode === 'nothing';
}

export function isKiosk(config: SelfOrderConfig): boolean {
    return config.mode === 'kiosk';
}

/**
 * Category time windows (SLF-023).
 *
 * `hour_after` / `hour_until` are float hours (`11.5` = 11:30). A window that wraps midnight
 * (`22 → 2`) is legitimate — a late-night menu — and is the case a naive `after <= now <= until`
 * gets wrong, so it is handled explicitly.
 */
export function isCategoryOpen(category: Pick<MenuCategory, 'hourAfter' | 'hourUntil'>, at: Date): boolean {
    const { hourAfter, hourUntil } = category;
    if (hourAfter === null && hourUntil === null) return true;

    const now = at.getHours() + at.getMinutes() / 60;
    const from = hourAfter ?? 0;
    const to = hourUntil ?? 24;

    if (from === to) return true;
    return from < to ? now >= from && now < to : now >= from || now < to;
}

export function isProductOrderable(catalog: Catalog, product: MenuProduct): boolean {
    if (!product.available) return false;
    const variants = catalog.variantsByProduct.get(product.id) ?? [];
    return variants.length === 0 ? false : variants.some((variant) => variant.available);
}

/** Categories with at least one orderable product, inside their time window. */
export function visibleCategories(catalog: Catalog, at: Date): MenuCategory[] {
    return catalog.categories.filter((category) => {
        if (!isCategoryOpen(category, at)) return false;
        const products = catalog.productsByCategory.get(category.id) ?? [];
        return products.some((product) => isProductOrderable(catalog, product));
    });
}

export function productsIn(catalog: Catalog, categoryId: number): MenuProduct[] {
    return (catalog.productsByCategory.get(categoryId) ?? []).filter((product) =>
        isProductOrderable(catalog, product),
    );
}

/**
 * The presets a customer may choose from (SLF-021).
 *
 * On mobile without a scanned table, `service_at = 'table'` presets are hidden: offering "eat in at
 * table 4" to somebody who never scanned table 4 produces an order nobody can deliver. A kiosk
 * shows everything, because a kiosk *is* the counter.
 */
export function availablePresets(catalog: Catalog, config: SelfOrderConfig, hasTable: boolean) {
    if (isKiosk(config)) return catalog.presets;
    return catalog.presets.filter((preset) => preset.serviceAt !== 'table' || hasTable);
}
