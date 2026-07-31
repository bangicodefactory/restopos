/**
 * The one place this app talks JSON instead of Inertia.
 *
 * Exactly two back-office writes answer with JSON rather than a redirect:
 * `POST /pos-configs/{config}/pairing-codes` (spec 05 §12.1 — "JSON, not a redirect"). Everything
 * else is an Inertia visit, and should stay that way.
 *
 * The CSRF token comes from the `<meta name="csrf-token">` in `app.blade.php`.
 */

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

function csrfToken(): string {
    return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-TOKEN': csrfToken(),
        },
        body: JSON.stringify(body),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
        const envelope = payload as { error?: { code?: string; message?: string }; message?: string } | null;
        throw new HttpError(
            response.status,
            envelope?.error?.message ?? envelope?.message ?? `HTTP ${response.status}`,
            envelope?.error?.code,
        );
    }

    return payload as T;
}
