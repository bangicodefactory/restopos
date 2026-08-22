/**
 * URL builders for every back-office route in `routes/web.php`.
 *
 * No Ziggy: it is a runtime route dump plus a Blade directive, and this app has exactly the
 * routes below, all of them stable and all of them declared in spec 05 §12/§12.1. A typo here is
 * a compile error at the call site instead of a 404 in production.
 *
 * **Model-bound routes take the record's `uuid`, not its `id`.** Every model behind these routes
 * uses the `HasUuid` trait, whose route-model binding resolves by `uuid` (never by `id`); passing
 * an `id` 404s. The `uuid: string` parameter type is deliberate — it makes handing an id a compile
 * error here rather than a 404 in production (BAN-499). Routes whose model is *not* `HasUuid`
 * (categories, pricelists, taxes, payment methods, employees, printers) still take a numeric `id`.
 */

export const routes = {
    login: (): string => '/login',
    logout: (): string => '/logout',

    dashboard: (): string => '/',

    posConfigs: {
        index: (): string => '/pos-configs',
        edit: (uuid: string): string => `/pos-configs/${uuid}/edit`,
        update: (uuid: string): string => `/pos-configs/${uuid}`,
        pairingCodes: (uuid: string): string => `/pos-configs/${uuid}/pairing-codes`,
    },

    products: {
        index: (): string => '/products',
        edit: (uuid: string): string => `/products/${uuid}/edit`,
        update: (uuid: string): string => `/products/${uuid}`,
    },

    categories: {
        index: (): string => '/categories',
        store: (): string => '/categories',
        update: (id: number): string => `/categories/${id}`,
        destroy: (id: number): string => `/categories/${id}`,
    },

    pricelists: {
        index: (): string => '/pricelists',
        edit: (id: number): string => `/pricelists/${id}/edit`,
        update: (id: number): string => `/pricelists/${id}`,
    },

    taxes: {
        index: (): string => '/taxes',
        store: (): string => '/taxes',
        update: (id: number): string => `/taxes/${id}`,
        destroy: (id: number): string => `/taxes/${id}`,
    },

    taxGroups: {
        store: (): string => '/tax-groups',
        update: (id: number): string => `/tax-groups/${id}`,
        destroy: (id: number): string => `/tax-groups/${id}`,
    },

    paymentMethods: {
        index: (): string => '/payment-methods',
        store: (): string => '/payment-methods',
        update: (id: number): string => `/payment-methods/${id}`,
        destroy: (id: number): string => `/payment-methods/${id}`,
    },

    employees: {
        index: (): string => '/employees',
        update: (id: number): string => `/employees/${id}`,
    },

    floors: {
        index: (): string => '/floors',
        edit: (uuid: string): string => `/floors/${uuid}/edit`,
        update: (uuid: string): string => `/floors/${uuid}`,
        rotateTableToken: (tableUuid: string): string => `/tables/${tableUuid}/rotate-token`,
    },

    orders: {
        index: (): string => '/orders',
        show: (uuid: string): string => `/orders/${uuid}`,
    },

    sessions: {
        index: (): string => '/sessions',
        show: (uuid: string): string => `/sessions/${uuid}`,
        close: (uuid: string): string => `/sessions/${uuid}/close`,
        accountingExports: (): string => '/accounting-exports',
    },

    reports: {
        salesDetails: (): string => '/reports/sales-details',
        session: (): string => '/reports/session',
        orderAnalytics: (): string => '/reports/order-analytics',
    },

    printers: {
        index: (): string => '/printers',
        update: (id: number): string => `/printers/${id}`,
        test: (id: number): string => `/printers/${id}/test`,
    },

    prepDisplays: {
        index: (): string => '/prep-displays',
        edit: (uuid: string): string => `/prep-displays/${uuid}/edit`,
        update: (uuid: string): string => `/prep-displays/${uuid}`,
        rotateToken: (uuid: string): string => `/prep-displays/${uuid}/rotate-token`,
    },

    selfOrder: {
        settings: (configUuid: string): string => `/self-order/${configUuid}/settings`,
        update: (configUuid: string): string => `/self-order/${configUuid}/settings`,
        rotateToken: (configUuid: string): string => `/self-order/${configUuid}/rotate-token`,
    },

    devices: {
        index: (): string => '/devices',
        destroy: (uuid: string): string => `/devices/${uuid}`,
    },

    /** PWA shells — linked from the dashboard's "open the register" action. */
    shells: {
        register: (configId: number): string => `/pos/${configId}`,
        customerDisplay: (configId: number): string => `/pos/${configId}/display`,
        kitchen: (displayToken: string): string => `/kitchen/${displayToken}`,
        selfOrder: (configToken: string): string => `/menu/${configToken}`,
    },
} as const;

/** Absolute URL for a path, for QR codes and copy-to-clipboard. */
export function absoluteUrl(path: string): string {
    const origin = typeof globalThis.location === 'undefined' ? '' : globalThis.location.origin;
    return `${origin}${path}`;
}
