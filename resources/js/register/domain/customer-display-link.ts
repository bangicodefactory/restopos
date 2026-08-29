/**
 * The URL a second-device customer display is opened at (REG-356, BAN-443a).
 *
 * One function, in `domain/`, because three places have to agree on it and two of them are React:
 * the navbar dialog shows it, the "open a window" button navigates to it, and the display itself
 * parses it back apart (`displayTokenFromUrl` / `displayConfigIdFromUrl`). A URL assembled inline in
 * a component is one a test cannot reach.
 *
 * `t` is the customer-display capability token from the bootstrap config row — **not**
 * `access_token`, which is the self-order token printed on every table's QR. A display URL must not
 * be convertible into a menu URL, and the server derives one from the other so it is not.
 */
export function customerDisplayUrl(origin: string, configId: number, token: string | null): string {
    const base = `${origin.replace(/\/$/, '')}/pos/${configId}/display`;

    // No token, no remote leg — and the URL still works, on the same machine, over
    // `BroadcastChannel`. That is the second-monitor wiring, and it is not a degraded mode.
    return token === null || token === '' ? base : `${base}?t=${encodeURIComponent(token)}`;
}
