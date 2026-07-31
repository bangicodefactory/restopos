import { ApiClient, ApiError } from '@shared/sync';

import type {
    KitchenBoardResponse,
    KitchenLineState,
    KitchenMutationResponse,
    KitchenStage,
} from './types';

/**
 * The kitchen display's HTTP surface — `docs/spec/05-api-contract.md` §1, §2 and §9, and nothing
 * else.
 *
 * Built on `@shared/sync`'s `ApiClient`, which already owns bearer auth, timeouts, `ETag`
 * handling and error classification. This file adds only the endpoint shapes, so a contract change
 * lands in exactly one place.
 *
 * A `prep_display` device token carries `pos:catalog`, `pos:kitchen` and `pos:realtime`. Notably
 * **not** `pos:sync` — a kitchen screen can never write an order, which is why nothing here posts
 * to `/api/pos/sync`.
 */

export const KDS_CLIENT_VERSION = '1.0.0';

/** `POST /api/devices/pair` — the shape the server actually answers with (spec §1). */
export type PairResponse = {
    device: {
        id: number;
        uuid: string;
        name: string;
        device_identifier: number;
        device_type: string;
    };
    config: { id: number; name: string; access_token: string; is_restaurant: boolean; currency_id: number };
    token: string;
    abilities: string[];
    device_secret: string;
    server_time: string;
    min_client_version: string;
    schema_version: number;
};

/** The slice of `GET /api/pos/bootstrap` a display asks for. */
export type KitchenBootstrap = {
    server_time: string;
    config_revision: number;
    data: {
        prep_displays?: Array<{
            id: number;
            name: string;
            access_token: string | null;
            layout?: string;
            pos_category_ids?: number[];
        }>;
        pos_categories?: Array<{ id: number; name: string; sequence: number; parent_id: number | null }>;
        products?: Array<{ id: number; name: string; pos_category_ids: number[] }>;
        pos_config?: { id: number; name: string; access_token: string } | Array<{ id: number; name: string; access_token: string }>;
    };
};

export function createApiClient(token: () => string | null): ApiClient {
    return new ApiClient({ token, clientVersion: KDS_CLIENT_VERSION });
}

export class KitchenApi {
    constructor(private readonly client: ApiClient) {}

    /** Auth: none — the pairing code *is* the credential. */
    async pair(code: string, name: string): Promise<PairResponse> {
        const response = await this.client.post<PairResponse>('/devices/pair', {
            code: code.trim().toUpperCase(),
            device_type: 'prep_display',
            name: name.trim() === '' ? 'Kitchen display' : name.trim(),
            hardware_fingerprint: fingerprint(),
            app_version: KDS_CLIENT_VERSION,
        });
        if (!response.data) throw new Error('Empty pairing response');
        return response.data;
    }

    /** Liveness + revocation probe. `410 device_revoked` surfaces as an `ApiError`. */
    async me(): Promise<{ device: { uuid: string; pos_config_id: number } }> {
        const response = await this.client.get<{ device: { uuid: string; pos_config_id: number } }>(
            '/devices/me',
        );
        if (!response.data) throw new Error('Empty device response');
        return response.data;
    }

    async unpair(): Promise<void> {
        await this.client.request('DELETE', '/devices/me', undefined);
    }

    /**
     * Displays, categories and the product→category map.
     *
     * The board payload identifies a line by `product_id` only (spec §9); `pos_category_id` rides
     * on the broadcast `Ticket` but not on the polled board. Category filtering therefore needs the
     * catalog, which is exactly what `pos:catalog` is for.
     */
    async bootstrap(): Promise<KitchenBootstrap> {
        const response = await this.client.get<KitchenBootstrap>('/pos/bootstrap', {
            query: { models: 'prep_displays,pos_categories,products,pos_config' },
        });
        if (!response.data) throw new Error('Empty bootstrap response');
        return response.data;
    }

    async board(displayToken: string, since?: string | null): Promise<KitchenBoardResponse> {
        const response = await this.client.get<KitchenBoardResponse>(
            `/kitchen/${encodeURIComponent(displayToken)}/orders`,
            { query: { since: since ?? undefined } },
        );
        if (!response.data) throw new Error('Empty board response');
        return response.data;
    }

    async stages(displayToken: string): Promise<KitchenStage[]> {
        const response = await this.client.get<{ stages: KitchenStage[] }>(
            `/kitchen/${encodeURIComponent(displayToken)}/stages`,
        );
        return response.data?.stages ?? [];
    }

    async setStage(
        displayToken: string,
        prepOrderId: number,
        stageId: number,
    ): Promise<KitchenMutationResponse> {
        const response = await this.client.post<KitchenMutationResponse>(
            `/kitchen/${encodeURIComponent(displayToken)}/orders/${prepOrderId}/stage`,
            { stage_id: stageId, employee_id: null },
        );
        if (!response.data) throw new Error('Empty stage response');
        return response.data;
    }

    async recall(displayToken: string, prepOrderId: number): Promise<KitchenMutationResponse> {
        const response = await this.client.post<KitchenMutationResponse>(
            `/kitchen/${encodeURIComponent(displayToken)}/orders/${prepOrderId}/recall`,
            { employee_id: null },
        );
        if (!response.data) throw new Error('Empty recall response');
        return response.data;
    }

    async setLineState(
        displayToken: string,
        lineId: number,
        state: KitchenLineState,
    ): Promise<KitchenMutationResponse> {
        const response = await this.client.post<KitchenMutationResponse>(
            `/kitchen/${encodeURIComponent(displayToken)}/lines/${lineId}/state`,
            { state, employee_id: null },
        );
        if (!response.data) throw new Error('Empty line-state response');
        return response.data;
    }
}

/**
 * `true` when the failure is the network rather than the server.
 *
 * The distinction decides whether an action goes back on the queue (offline: yes, keep it and the
 * optimistic state) or is rolled back (`422 invalid_stage`: no, the server will never accept it).
 */
export function isOffline(error: unknown): boolean {
    return error instanceof ApiError && error.sync.kind === 'offline';
}

/** `410 device_revoked` / `401` — the display must be re-paired before it can show anything. */
export function isAuthFailure(error: unknown): boolean {
    return error instanceof ApiError && error.sync.kind === 'auth';
}

export function errorCode(error: unknown): string | null {
    if (!(error instanceof ApiError)) return null;
    const body = error.body as { error?: { code?: string } } | null;
    return body?.error?.code ?? null;
}

function fingerprint(): string {
    const nav = globalThis.navigator;
    const screen = globalThis.screen;
    return [
        nav?.userAgent ?? 'unknown',
        screen ? `${screen.width}x${screen.height}` : '',
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    ]
        .join('|')
        // The server caps `hardware_fingerprint` at 128 chars (PairDeviceRequest);
        // modern user-agents alone can exceed that, so keep the low-order bytes.
        .slice(0, 128);
}
