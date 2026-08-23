/**
 * Detecting text that has been through the wrong decoder.
 *
 * Kept in its own module and written in **pure ASCII escapes**, for a reason that is not fussiness:
 * a detector spelled with the very characters it hunts for is one careless batch edit away from
 * being mangled itself - at which point it silently stops matching and reports a clean dictionary
 * forever.
 *
 * Three signatures, and each is a different wrong decoder:
 *
 *  - **UTF-8 read as latin-1.** A lead byte (U+00C2, U+00C3, U+00E2) followed by a *continuation
 *    byte* (U+0080 to U+00BF). This is what turned an acute-accented "e" into two characters across
 *    twenty-three strings on master. The continuation range is load-bearing: matching a lead byte
 *    followed by *anything* would flag legitimate Portuguese, where U+00C3 is an ordinary capital.
 *  - **UTF-8 read as cp1252.** The same bytes, except 0x80 maps to the euro sign rather than a
 *    control, so a curly quote becomes U+00E2 U+20AC instead of a lead/continuation pair.
 *  - **Any C1 control character** (U+0080 to U+009F). What that same quote becomes under latin-1,
 *    and the case sabotage caught: mangling a quote left an earlier version of this file green,
 *    because it matched only the cp1252 rendering. A C1 control has no business in a label whatever
 *    produced it, so the range is rejected outright.
 */

export const MOJIBAKE = new RegExp(
    '[\\u00C2\\u00C3\\u00E2][\\u0080-\\u00BF]' + // UTF-8 read as latin-1
        '|\\u00E2\\u20AC' + // UTF-8 read as cp1252
        '|[\\u0080-\\u009F]', // a stray C1 control, however it got there
    'u',
);

/** Every entry whose text has been mis-decoded, as `key: value` so the failure is legible. */
export function mojibakeIn(dictionary: Record<string, string>): string[] {
    return Object.entries(dictionary)
        .filter(([, value]) => MOJIBAKE.test(value))
        .map(([key, value]) => `${key}: ${value}`);
}
