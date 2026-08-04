/**
 * `SelfOrder/Settings` props — spec 05 §12.
 *
 * `config` here is a hand-picked projection of `pos_configs`, not `attributesToArray()`: only the
 * self-order fields, the venue `access_token` and the linked `custom_link_ids`.
 */

import type { EnumOption } from '../../types/inertia';

export type SelfOrderConfig = {
    id: number;
    uuid: string;
    name: string;
    access_token: string;
    self_ordering_mode: string;
    self_ordering_service_mode: string;
    self_ordering_pay_after: string;
    self_ordering_brand_name: string | null;
    self_ordering_primary_color: string | null;
    self_ordering_text_color: string | null;
    self_ordering_default_language_id: number | null;
    self_order_online_payment_method_id: number | null;
    kiosk_idle_seconds: number;
    kiosk_confirmation_seconds: number;
    custom_link_ids: number[];
};

export type CustomLinkRow = {
    id: number;
    name: string;
    url: string;
    style: string;
    open_in_new_tab: boolean;
    active: boolean;
};

export type SelfOrderPaymentMethod = {
    id: number;
    name: string;
    method_type: string;
};

export type SelfOrderSettingsProps = {
    config: SelfOrderConfig;
    modes: EnumOption[];
    serviceModes: EnumOption[];
    payAfterModes: EnumOption[];
    customLinks: CustomLinkRow[];
    paymentMethods: SelfOrderPaymentMethod[];
};

/** The keys `PATCH /self-order/{config}/settings` validates. */
export const WRITABLE_SELF_ORDER_KEYS = [
    'self_ordering_mode',
    'self_ordering_service_mode',
    'self_ordering_pay_after',
    'self_ordering_brand_name',
    'self_ordering_primary_color',
    'self_ordering_text_color',
    'self_order_online_payment_method_id',
    'kiosk_idle_seconds',
    'kiosk_confirmation_seconds',
    'custom_link_ids',
] as const;

export type SelfOrderForm = {
    self_ordering_mode: string;
    self_ordering_service_mode: string;
    self_ordering_pay_after: string;
    self_ordering_brand_name: string;
    self_ordering_primary_color: string | null;
    self_ordering_text_color: string | null;
    self_order_online_payment_method_id: number | null;
    kiosk_idle_seconds: number | null;
    kiosk_confirmation_seconds: number | null;
    custom_link_ids: number[];
};

export function toForm(config: SelfOrderConfig): SelfOrderForm {
    return {
        self_ordering_mode: config.self_ordering_mode,
        self_ordering_service_mode: config.self_ordering_service_mode,
        self_ordering_pay_after: config.self_ordering_pay_after,
        self_ordering_brand_name: config.self_ordering_brand_name ?? '',
        self_ordering_primary_color: config.self_ordering_primary_color,
        self_ordering_text_color: config.self_ordering_text_color,
        self_order_online_payment_method_id: config.self_order_online_payment_method_id,
        kiosk_idle_seconds: config.kiosk_idle_seconds,
        kiosk_confirmation_seconds: config.kiosk_confirmation_seconds,
        custom_link_ids: config.custom_link_ids,
    };
}

/**
 * Which controls a mode actually governs.
 *
 * `nothing` turns the whole surface off; `consultation` is a menu with no cart, so the pay-after
 * rule and the online payment method are meaningless there; the kiosk timers only exist in
 * `kiosk`. Dependent controls are disabled rather than hidden — "where did the kiosk timeout go?"
 * is a support call, a greyed field under an explanatory label is not.
 */
export function capabilitiesOf(mode: string): {
    ordering: boolean;
    payment: boolean;
    kiosk: boolean;
    service: boolean;
} {
    switch (mode) {
        case 'kiosk':
            return { ordering: true, payment: true, kiosk: true, service: false };
        case 'mobile':
            return { ordering: true, payment: true, kiosk: false, service: true };
        case 'consultation':
            return { ordering: false, payment: false, kiosk: false, service: false };
        default:
            return { ordering: false, payment: false, kiosk: false, service: false };
    }
}

export const PAY_AFTER_HINT: Record<string, string> = {
    each: 'Le client paie chaque commande au moment où il la valide.',
    meal: 'Le client commande plusieurs fois et paie à la fin du repas ; la note reste ouverte sur la table.',
};

/** `/menu/{token}` for the venue, plus `?tt=` for one table (spec 05 §, self-order API `?tt=`). */
export function selfOrderUrl(base: string, tableToken?: string | null): string {
    return tableToken && tableToken.trim() !== ''
        ? `${base}?tt=${encodeURIComponent(tableToken.trim())}`
        : base;
}

/** Split a pasted list of table tokens: newlines, commas, semicolons or spaces all work. */
export function parseTableTokens(raw: string): string[] {
    return [
        ...new Set(
            raw
                .split(/[\s,;]+/)
                .map((token) => token.trim())
                .filter((token) => token !== ''),
        ),
    ];
}
