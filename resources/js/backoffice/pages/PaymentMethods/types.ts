/**
 * `PaymentMethods/Index` props — spec 05 §12.
 *
 * `method_type` and `terminal_provider` are backed enums serialised to their string value; the
 * controller coerces both with `?->value ?? $m->…`, so an unmapped legacy value still arrives as
 * a plain string rather than throwing. The labels below are display-only and fall back to the
 * raw value for exactly that reason.
 */

export type PaymentMethodRow = {
    id: number;
    name: string;
    method_type: string;
    is_cash_count: boolean;
    currency_id: number;
    identify_customer: boolean;
    allow_change: boolean;
    allow_refund: boolean;
    is_rounding_target: boolean;
    terminal_provider: string;
    payment_provider_id: number | null;
    ledger_code: string | null;
    sequence: number;
    active: boolean;
};

export type PaymentProviderRow = {
    id: number;
    name: string;
    code: string;
    state: string;
};

export type PaymentMethodsIndexProps = {
    methods: PaymentMethodRow[];
    providers: PaymentProviderRow[];
};

/**
 * The keys `PATCH /payment-methods/{paymentMethod}` validates.
 *
 * `method_type`, `terminal_provider`, `payment_provider_id` and `currency_id` are **not** in the
 * rule set: Laravel drops them silently, so their controls are rendered locked with the reason
 * rather than as switches that forget.
 */
export const WRITABLE_PAYMENT_KEYS = [
    'name',
    'is_cash_count',
    'identify_customer',
    'allow_change',
    'allow_refund',
    'is_rounding_target',
    'ledger_code',
    'sequence',
    'active',
] as const;

export const METHOD_TYPE_LABEL: Record<string, string> = {
    cash: 'Espèces',
    bank: 'Virement / chèque',
    card_terminal: 'Terminal de paiement',
    qr_code: 'QR code',
    online: 'En ligne',
    customer_account: 'Compte client',
    voucher: 'Bon / avoir',
};

export const TERMINAL_LABEL: Record<string, string> = {
    none: 'Aucun',
    adyen: 'Adyen',
    stripe: 'Stripe',
    viva: 'Viva',
    razorpay: 'Razorpay',
    mercado_pago: 'Mercado Pago',
    pine_labs: 'Pine Labs',
    qfpay: 'QFPay',
    six: 'SIX',
    other: 'Autre',
};

/** Types that are settled online rather than at the till. */
export const ONLINE_METHOD_TYPES = new Set(['online', 'qr_code']);

export type PaymentMethodForm = {
    name: string;
    is_cash_count: boolean;
    identify_customer: boolean;
    allow_change: boolean;
    allow_refund: boolean;
    is_rounding_target: boolean;
    ledger_code: string;
    sequence: number | null;
    active: boolean;
};

export function toForm(method: PaymentMethodRow): PaymentMethodForm {
    return {
        name: method.name,
        is_cash_count: method.is_cash_count,
        identify_customer: method.identify_customer,
        allow_change: method.allow_change,
        allow_refund: method.allow_refund,
        is_rounding_target: method.is_rounding_target,
        ledger_code: method.ledger_code ?? '',
        sequence: method.sequence,
        active: method.active,
    };
}
