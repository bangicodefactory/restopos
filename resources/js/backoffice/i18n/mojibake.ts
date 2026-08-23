/**
 * Detecting text that has been through the wrong decoder.
 *
 * Kept in its own module, written in **pure ASCII escapes**, for a reason that is not fussiness: a
 * detector spelled with the very characters it hunts for is one careless batch edit away from being
 * mangled itself - at which point it silently stops matching and reports a clean dictionary forever.
 *
 * Three signatures:
 *
 *  - `U+00C3` / `U+00C2` followed by anything - UTF-8 read as latin-1, the classic `Refus` + `U+00C3 U+00A9` pair.
 *    Matched as a pair because U+00C3 is a legitimate letter on its own.
 *  - `U+00E2 U+20AC` - what a curly quote becomes when the bytes are read as **cp1252**.
 *  - Any **C1 control character** (``-``) - what that same quote becomes when the bytes
 *    are read as **latin-1** instead. The first two patterns miss this entirely; sabotage found it
 *    by mangling a quote and leaving the test green. A C1 control has no business in a label under
 *    any circumstances, so the whole range is rejected rather than paired with anything.
 */

export const MOJIBAKE = /[\u00C3\u00C2].|\u00E2\u20AC|[\u0080-\u009F]/u;

/** Every entry whose text has been mis-decoded, as `key: value` for a legible failure. */
export function mojibakeIn(dictionary: Record<string, string>): string[] {
    return Object.entries(dictionary)
        .filter(([, value]) => MOJIBAKE.test(value))
        .map(([key, value]) => `${key}: ${value}`);
}
