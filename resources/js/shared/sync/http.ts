import { classifyHttpError, type SyncError } from '@domain/sync/wire';

/**
 * The JSON transport for every offline client.
 *
 * Deliberately thin — no interceptor stack, no retry, no cache. Retry policy lives in the outbox
 * (one place), caching lives in IndexedDB (one place). This module only knows how to make one
 * authenticated request and how to classify what came back.
 *
 * Auth is a Sanctum **device bearer token**, never a session cookie: these are long-lived
 * unattended devices, and the shells are propless so there is no CSRF token in the document.
 */

export type ApiOptions = {
    baseUrl?: string;
    /** Bearer token; a function so a token rotation is picked up without rebuilding the client. */
    token: () => string | null;
    clientVersion: string;
    fetchImpl?: typeof fetch;
    /** Per-request timeout. A till must not hang on a half-open socket. */
    timeoutMs?: number;
};

export class ApiError extends Error {
    constructor(
        readonly status: number | undefined,
        readonly sync: SyncError,
        readonly body: unknown,
    ) {
        super(`API error: ${sync.kind}${status ? ` (${status})` : ''}`);
        this.name = 'ApiError';
    }
}

export type RequestOptions = {
    query?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Sent as `If-None-Match`; a 304 resolves to `null`. */
    etag?: string | null;
    /** Idempotency key for a push attempt-group (spec 03 §3.6.3). */
    idempotencyKey?: string;
    timeoutMs?: number;
    /**
     * How to read the body. `json` is the default and what every sync endpoint speaks.
     *
     * `blob` exists for media (BAN-480): the bytes are behind a device-authenticated route, and an
     * `<img src>` cannot carry a bearer token — so the client fetches them here, where the token
     * lives, and renders from an object URL.
     */
    responseType?: 'json' | 'blob';
};

export type ApiResponse<T> = {
    /** `null` when the server answered 304 Not Modified. */
    data: T | null;
    status: number;
    etag: string | null;
    notModified: boolean;
};

export class ApiClient {
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(private readonly options: ApiOptions) {
        this.baseUrl = (options.baseUrl ?? '/api').replace(/\/$/, '');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.timeoutMs = options.timeoutMs ?? 20_000;
    }

    get<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
        return this.request<T>('GET', path, undefined, options);
    }

    post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
        return this.request<T>('POST', path, body, options);
    }

    async request<T>(
        method: string,
        path: string,
        body: unknown,
        options: RequestOptions = {},
    ): Promise<ApiResponse<T>> {
        const url = this.buildUrl(path, options.query);

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'X-Client-Version': this.options.clientVersion,
            ...options.headers,
        };
        const token = this.options.token();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (options.etag) headers['If-None-Match'] = options.etag;
        if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
        if (options.signal) {
            options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
                credentials: 'omit',
                cache: 'no-store',
            });
        } catch (error) {
            // A network failure and an abort are indistinguishable to the caller, and both mean
            // "we are offline as far as this request is concerned".
            throw new ApiError(undefined, { kind: 'offline' }, error);
        } finally {
            clearTimeout(timeout);
        }

        const etag = response.headers.get('ETag');

        if (response.status === 304) {
            return { data: null, status: 304, etag, notModified: true };
        }

        if (!response.ok) {
            const parsed = await safeJson(response);
            throw new ApiError(response.status, classifyHttpError(response.status, parsed ?? undefined), parsed);
        }

        if (response.status === 204) {
            return { data: null, status: 204, etag, notModified: false };
        }

        const data = options.responseType === 'blob'
            ? ((await response.blob()) as T)
            : ((await response.json()) as T);

        return { data, status: response.status, etag, notModified: false };
    }

    private buildUrl(path: string, query?: RequestOptions['query']): string {
        const base = `${this.baseUrl}/${path.replace(/^\//, '')}`;
        if (!query) return base;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === null || value === undefined || value === '') continue;
            params.set(key, String(value));
        }
        const qs = params.toString();
        return qs === '' ? base : `${base}?${qs}`;
    }
}

async function safeJson(response: Response): Promise<{ message?: string; min_client_version?: string } | null> {
    try {
        return (await response.json()) as { message?: string };
    } catch {
        return null;
    }
}

/** `true` when the browser believes it is online. Advisory only — the network is the real test. */
export function browserOnline(): boolean {
    return globalThis.navigator?.onLine !== false;
}
