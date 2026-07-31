/**
 * Vitest global setup.
 *
 * Deliberately almost empty: `packages/domain` is framework-free and must run under plain Node with
 * no shims. The only thing we assert here is that the two Web APIs the domain layer *does* rely on
 * (WebCrypto for token generation, TextEncoder for codepage-neutral encoding) are present, so a
 * missing polyfill fails loudly at setup rather than mysteriously inside a test.
 */

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('WebCrypto is required (Node 20+). packages/domain uses crypto.getRandomValues.');
}

if (typeof globalThis.TextEncoder !== 'function') {
    throw new Error('TextEncoder is required.');
}
