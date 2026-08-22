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
    /**
     * Whether a terminal configuration exists — never what it holds. `terminal_config` is
     * `encrypted:array` and in the model's `$hidden`: it carries the terminal's pairing secret, and
     * an Inertia prop is page source.
     */
    has_terminal_config: boolean;
    qr_code_method: string;
    default_qr_payload: string | null;
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

export type CurrencyRow = {
    id: number;
    code: string;
    name: string;
};

export type PaymentMethodsIndexProps = {
    methods: PaymentMethodRow[];
    providers: PaymentProviderRow[];
    currencies: CurrencyRow[];
};

/**
 * The keys `PATCH /payment-methods/{paymentMethod}` validates (BAN-424).
 *
 * `image_media_id` is accepted by the endpoint but absent here and has no control: there is no media
 * *upload* route in the app — only `GET /api/media/{id}` to serve one — so a picker would offer a
 * choice of nothing. Said plainly rather than rendered as a locked field implying the endpoint is
 * the obstacle.
 *
 * `terminal_config` is write-only. It is `encrypted:array` and `$hidden` on the model because it
 * holds the terminal's pairing secret; the page is told only whether one exists.
 */
export const WRITABLE_PAYMENT_KEYS = [
    'name',
    'method_type',
    'currency_id',
    'is_cash_count',
    'identify_customer',
    'allow_change',
    'allow_refund',
    'is_rounding_target',
    'terminal_provider',
    'payment_provider_id',
    'terminal_config',
    'qr_code_method',
    'default_qr_payload',
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

export const QR_METHOD_LABEL: Record<string, string> = {
    none: 'Aucun',
    emv: 'EMVCo',
    sepa: 'SEPA',
    swiss: 'Swiss QR',
    pix: 'Pix',
    upi: 'UPI',
    promptpay: 'PromptPay',
};

/** Types that are settled online rather than at the till. */
export const ONLINE_METHOD_TYPES = new Set(['online', 'qr_code']);

export type PaymentMethodForm = {
    name: string;
    method_type: string;
    currency_id: number;
    terminal_provider: string;
    payment_provider_id: string;
    qr_code_method: string;
    default_qr_payload: string;
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
        method_type: method.method_type,
        currency_id: method.currency_id,
        terminal_provider: method.terminal_provider,
        // A select's value is a string; `''` is "no provider", which the endpoint takes as null.
        payment_provider_id: method.payment_provider_id === null ? '' : String(method.payment_provider_id),
        qr_code_method: method.qr_code_method,
        default_qr_payload: method.default_qr_payload ?? '',
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
