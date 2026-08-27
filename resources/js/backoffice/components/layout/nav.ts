/**
 * The navigation tree.
 *
 * Structure mirrors Odoo's Point-of-Sale menu (Dashboard / Orders / Products / Reporting /
 * Configuration) so an operator migrating from Odoo finds things where they expect them.
 *
 * Some entries in that tree have **no back-office route in spec 05 §12** — payments, customers,
 * variants, combos, presets, coins & bills. They are kept in the menu and rendered disabled with
 * an explanation rather than silently dropped: an operator hunting for "Coins & bills" needs to
 * learn that it is not built yet, not that they are looking in the wrong place.
 */

import type { BoKey } from '../../i18n';
import { routes } from '../../lib/routes';

export type NavItem = {
    key: string;
    labelKey: BoKey;
    href: string | null;
    /** Matches the current URL by prefix (for detail pages under a list). */
    match?: (path: string) => boolean;
    /**
     * Set when the entry cannot be linked: either the contract exposes no route for it
     * (`nav.unavailable`) or the screen only exists per register (`nav.perRegister`).
     */
    disabledReasonKey?: BoKey;
};

export type NavGroup = {
    key: string;
    labelKey: BoKey | null;
    items: NavItem[];
};

const startsWith =
    (prefix: string) =>
    (path: string): boolean =>
        path === prefix || path.startsWith(`${prefix}/`);

export const NAV: NavGroup[] = [
    {
        key: 'root',
        labelKey: null,
        items: [
            {
                key: 'dashboard',
                labelKey: 'nav.dashboard',
                href: routes.dashboard(),
                match: (path) => path === '/' || path === '',
            },
        ],
    },
    {
        key: 'orders',
        labelKey: 'nav.group.orders',
        items: [
            { key: 'orders', labelKey: 'nav.orders', href: routes.orders.index(), match: startsWith('/orders') },
            { key: 'sessions', labelKey: 'nav.sessions', href: routes.sessions.index(), match: startsWith('/sessions') },
            { key: 'payments', labelKey: 'nav.payments', href: null, disabledReasonKey: 'nav.unavailable' },
            {
                key: 'printers',
                labelKey: 'nav.prepPrinters',
                href: routes.printers.index(),
                match: startsWith('/printers'),
            },
            { key: 'customers', labelKey: 'nav.customers', href: null, disabledReasonKey: 'nav.unavailable' },
        ],
    },
    {
        key: 'products',
        labelKey: 'nav.group.products',
        items: [
            { key: 'products', labelKey: 'nav.products', href: routes.products.index(), match: startsWith('/products') },
            {
                key: 'product-categories',
                labelKey: 'nav.productCategories',
                href: routes.productCategories.index(),
                match: startsWith('/product-categories'),
            },
            {
                key: 'attributes',
                labelKey: 'nav.attributes',
                href: routes.productAttributes.index(),
                match: startsWith('/product-attributes'),
            },
            { key: 'combos', labelKey: 'nav.combos', href: null, disabledReasonKey: 'nav.unavailable' },
            {
                key: 'pricelists',
                labelKey: 'nav.pricelists',
                href: routes.pricelists.index(),
                match: startsWith('/pricelists'),
            },
            {
                key: 'categories',
                labelKey: 'nav.categories',
                href: routes.categories.index(),
                match: startsWith('/categories'),
            },
        ],
    },
    {
        key: 'reporting',
        labelKey: 'nav.group.reporting',
        items: [
            {
                key: 'sales-details',
                labelKey: 'nav.salesDetails',
                href: routes.reports.salesDetails(),
                match: startsWith('/reports/sales-details'),
            },
            {
                key: 'session-report',
                labelKey: 'nav.sessionReport',
                href: routes.reports.session(),
                match: startsWith('/reports/session'),
            },
            {
                key: 'order-analytics',
                labelKey: 'nav.orderAnalytics',
                href: routes.reports.orderAnalytics(),
                match: startsWith('/reports/order-analytics'),
            },
        ],
    },
    {
        key: 'configuration',
        labelKey: 'nav.group.configuration',
        items: [
            {
                key: 'pos-configs',
                labelKey: 'nav.posConfigs',
                href: routes.posConfigs.index(),
                match: startsWith('/pos-configs'),
            },
            { key: 'presets', labelKey: 'nav.presets', href: null, disabledReasonKey: 'nav.unavailable' },
            {
                key: 'payment-methods',
                labelKey: 'nav.paymentMethods',
                href: routes.paymentMethods.index(),
                match: startsWith('/payment-methods'),
            },
            { key: 'taxes', labelKey: 'nav.taxes', href: routes.taxes.index(), match: startsWith('/taxes') },
            { key: 'bills', labelKey: 'nav.bills', href: routes.posBills.index(), match: startsWith('/pos-bills') },
            { key: 'notes', labelKey: 'nav.notes', href: routes.posNotes.index(), match: startsWith('/pos-notes') },
            { key: 'floors', labelKey: 'nav.floors', href: routes.floors.index(), match: startsWith('/floors') },
            {
                key: 'prep-displays',
                labelKey: 'nav.prepDisplays',
                href: routes.prepDisplays.index(),
                match: startsWith('/prep-displays'),
            },
            {
                key: 'self-order',
                labelKey: 'nav.selfOrder',
                href: null,
                match: startsWith('/self-order'),
                disabledReasonKey: 'nav.perRegister',
            },
            {
                key: 'employees',
                labelKey: 'nav.employees',
                href: routes.employees.index(),
                match: startsWith('/employees'),
            },
            { key: 'devices', labelKey: 'nav.devices', href: routes.devices.index(), match: startsWith('/devices') },
        ],
    },
];

/** The item matching a path, for the sidebar's active state and the breadcrumb root. */
export function findActive(path: string): { group: NavGroup; item: NavItem } | null {
    for (const group of NAV) {
        for (const item of group.items) {
            const matched = item.match ? item.match(path) : item.href !== null && item.href === path;
            if (matched) return { group, item };
        }
    }
    return null;
}
