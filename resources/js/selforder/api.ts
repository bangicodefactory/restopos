import { ApiClient, ApiError } from '@shared/sync';

import type { SubmitLine } from './logic/cart';
import type {
    MenuResponse,
    PaymentConfirmation,
    PaymentIntent,
    SelfOrderStatus,
    SubmitOrderResponse,
} from './types';

/**
 * The public self-order API — `docs/spec/05-api-contract.md` §10, and nothing beyond it.
 *
 * Auth here is *capability*, not identity: the config token in the path grants access to the venue's
 * menu, the optional table token binds a cart to a table, and the per-order `access_token` is the
 * only credential for viewing, cancelling or paying one order. There is no account, no cookie and
 * no device token — which is exactly right for a stranger with a phone, and why every one of those
 * tokens is treated as a secret in storage.
 */

export const SELF_ORDER_CLIENT_VERSION = '1.0.0';

export type SubmitOrderInput = {
    orderUuid?: string;
    presetId: number | null;
    customerNote: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    tableStandNumber: string | null;
    lines: SubmitLine[];
};

export class SelfOrderApi {
    private readonly client: ApiClient;

    constructor(
        private readonly configToken: string,
        private readonly tableToken: string | null,
        fetchImpl?: typeof fetch,
    ) {
        this.client = new ApiClient({
            // Anonymous: no bearer token ever goes on these requests.
            token: () => null,
            clientVersion: SELF_ORDER_CLIENT_VERSION,
            ...(fetchImpl ? { fetchImpl } : {}),
        });
    }

    private path(suffix = ''): string {
        return `/self-order/${encodeURIComponent(this.configToken)}${suffix}`;
    }

    private get tableQuery(): Record<string, string | undefined> {
        return this.tableToken ? { tt: this.tableToken } : {};
    }

    async menu(): Promise<MenuResponse> {
        const response = await this.client.get<MenuResponse>(this.path('/menu'), {
            query: this.tableQuery,
        });
        if (!response.data) throw new Error('Empty menu response');
        return response.data;
    }

    /**
     * Create or append (SLF-036).
     *
     * Whether this starts a new order or joins the table's existing tab is decided by the *config*,
     * never by the client (`appended` in the response). Sending the same `order_uuid` again appends;
     * omitting it always starts fresh.
     */
    async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResponse> {
        const response = await this.client.post<SubmitOrderResponse>(
            this.path('/orders'),
            {
                order_uuid: input.orderUuid,
                preset_id: input.presetId,
                customer_note: input.customerNote,
                customer_email: input.customerEmail,
                customer_phone: input.customerPhone,
                table_stand_number: input.tableStandNumber,
                lines: input.lines,
            },
            { query: this.tableQuery },
        );
        if (!response.data) throw new Error('Empty order response');
        return response.data;
    }

    async orderStatus(orderUuid: string, orderToken: string): Promise<SelfOrderStatus> {
        const response = await this.client.get<SelfOrderStatus>(
            this.path(`/orders/${encodeURIComponent(orderUuid)}`),
            { headers: { 'X-Order-Token': orderToken }, query: this.tableQuery },
        );
        if (!response.data) throw new Error('Empty status response');
        return response.data;
    }

    async cancelOrder(orderUuid: string, orderToken: string): Promise<SelfOrderStatus> {
        const response = await this.client.post<SelfOrderStatus>(
            this.path(`/orders/${encodeURIComponent(orderUuid)}/cancel`),
            {},
            { headers: { 'X-Order-Token': orderToken } },
        );
        if (!response.data) throw new Error('Empty cancel response');
        return response.data;
    }

    async createPaymentIntent(
        orderUuid: string,
        orderToken: string,
        returnUrl: string,
    ): Promise<PaymentIntent> {
        const response = await this.client.post<PaymentIntent>(
            this.path(`/orders/${encodeURIComponent(orderUuid)}/payment-intent`),
            { return_url: returnUrl },
            { headers: { 'X-Order-Token': orderToken } },
        );
        if (!response.data) throw new Error('Empty payment-intent response');
        return response.data;
    }

    async confirmPayment(
        orderUuid: string,
        orderToken: string,
        reference: string,
        payload: Record<string, unknown> = {},
    ): Promise<PaymentConfirmation> {
        const response = await this.client.post<PaymentConfirmation>(
            this.path(`/orders/${encodeURIComponent(orderUuid)}/payment-confirm`),
            { reference, payload },
            { headers: { 'X-Order-Token': orderToken } },
        );
        if (!response.data) throw new Error('Empty payment-confirm response');
        return response.data;
    }
}

export function isOffline(error: unknown): boolean {
    return error instanceof ApiError && error.sync.kind === 'offline';
}

/** `403 invalid_config_token` / `404 self_order_disabled` — a dead QR, not a transient failure. */
export function errorCode(error: unknown): string | null {
    if (!(error instanceof ApiError)) return null;
    const body = error.body as { error?: { code?: string } } | null;
    return body?.error?.code ?? null;
}

export function isDeadToken(error: unknown): boolean {
    const code = errorCode(error);
    return code === 'invalid_config_token' || code === 'invalid_table_token' || code === 'self_order_disabled';
}
