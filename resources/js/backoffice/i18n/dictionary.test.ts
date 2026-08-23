/**
 * The dictionary is what the operator reads, so it is worth asserting it is readable.
 *
 * Both checks here caught real, shipped defects rather than hypothetical ones.
 *
 * **Mis-decoded text.** Twenty-three French strings reached master with their accents replaced by
 * two-character sequences - UTF-8 written into a UTF-8 file after already being decoded as something
 * else. Nothing failed: typecheck passes, lint passes, the suite passes, and the only signal is a
 * French speaker looking at the screen. That is precisely the kind of defect a test has to carry,
 * because review will not. See `./mojibake` for what is matched and why.
 *
 * **Parity.** A key added to one dictionary and not the other falls back to the raw key, so a
 * control reads `payment.terminalConfigSet` instead of a sentence - in one language only, which is
 * the half nobody testing in the other language will ever see.
 */

import { describe, expect, it } from 'vitest';

import { BO_DICTIONARIES } from './dictionary';
import { mojibakeIn } from './mojibake';

/** `[locale, dictionary]` pairs, so nothing downstream indexes a `Record` and gets `undefined`. */
const LOCALES: [string, Record<string, string>][] = Object.entries(BO_DICTIONARIES);

describe('the back-office dictionary', () => {
    it('ships more than one locale, or these checks prove nothing', () => {
        expect(LOCALES.length).toBeGreaterThan(1);
    });

    it.each(LOCALES)('has no mis-decoded text in %s', (_locale, dictionary) => {
        expect(mojibakeIn(dictionary)).toEqual([]);
    });

    it('translates the same set of keys in every locale', () => {
        const [reference, ...rest] = LOCALES;
        const expected = Object.keys(reference?.[1] ?? {}).sort();

        for (const [locale, dictionary] of rest) {
            const actual = Object.keys(dictionary).sort();

            expect({
                locale,
                missing: expected.filter((key) => !actual.includes(key)),
                extra: actual.filter((key) => !expected.includes(key)),
            }).toEqual({ locale, missing: [], extra: [] });
        }
    });

    it('leaves no value empty, which renders as a blank control', () => {
        for (const [locale, dictionary] of LOCALES) {
            const blank = Object.entries(dictionary)
                .filter(([, value]) => value.trim() === '')
                .map(([key]) => key);

            expect({ locale, blank }).toEqual({ locale, blank: [] });
        }
    });
});
