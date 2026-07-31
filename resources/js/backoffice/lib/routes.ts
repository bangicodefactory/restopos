/**
 * URL builders for every back-office route in `routes/web.php`.
 *
 * No Ziggy: it is a runtime route dump plus a Blade directive, and this app has exactly the
 * routes below, all of them stable and all of them declared in spec 05 §12/§12.1. A typo here is
 * a compile error at the call site instead of a 404 in production.
 */

export const routes = {
    login: (): string => '/login',
    logout: (): string => '/logout',

    dashboard: (): string => '/',

    posConfigs: {
        index: (): string => '/pos-configs',
        edit: (id: number): string => `/pos-configs/${id}/edit`,
        update: (id: number): string => `/pos-configs/${id}`,
        pairingCodes: (id: number): string => `/pos-configs/${id}/pairing-codes`,
    },

    products: {
        index: (): string => '/products',
        edit: (id: number): string => `/products/${id}/edit`,
        update: (id: number): string => `/products/${id}`,
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
        update: (id: number): string => `/taxes/${id}`,
    },

    paymentMethods: {
        index: (): string => '/payment-methods',
        update: (id: number): string => `/payment-methods/${id}`,
    },

    employees: {
        index: (): string => '/employees',
        update: (id: number): string => `/employees/${id}`,
    },

    floors: {
        index: (): string => '/floors',
        edit: (id: number): string => `/floors/${id}/edit`,
        update: (id: number): string => `/floors/${id}`,
        rotateTableToken: (tableId: number): string => `/tables/${tableId}/rotate-token`,
    },

    orders: {
        index: (): string => '/orders',
        show: (id: number | string): string => `/orders/${id}`,
    },

    sessions: {
        index: (): string => '/sessions',
        show: (id: number): string => `/sessions/${id}`,
        close: (id: number): string => `/sessions/${id}/close`,
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
        edit: (id: number): string => `/prep-displays/${id}/edit`,
        update: (id: number): string => `/prep-displays/${id}`,
    },

    selfOrder: {
        settings: (configId: number): string => `/self-order/${configId}/settings`,
        update: (configId: number): string => `/self-order/${configId}/settings`,
        rotateToken: (configId: number): string => `/self-order/${configId}/rotate-token`,
    },

    devices: {
        index: (): string => '/devices',
        destroy: (id: number): string => `/devices/${id}`,
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
