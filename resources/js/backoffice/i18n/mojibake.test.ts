/**
 * The detector itself, on strings built from escapes rather than typed literally.
 *
 * Every fixture here is spelled `\uXXXX` on purpose. A test for mis-decoded text whose *fixtures*
 * are pasted characters is a test that can be silently defeated by the same batch edit it exists to
 * catch: the mangled input would round-trip into a mangled expectation and still agree with itself.
 */

import { describe, expect, it } from 'vitest';

import { mojibakeIn } from './mojibake';

/** A legitimate accented character: e-acute. */
const E_ACUTE = '\u00E9';
/** A legitimate curly apostrophe. */
const CURLY = '\u2019';
/** A legitimate capital in Portuguese - and the lead byte of the classic mangling. */
const A_TILDE_CAPITAL = '\u00C3';

/** What e-acute becomes when its UTF-8 bytes are read as latin-1. */
const E_ACUTE_MANGLED = '\u00C3\u00A9';
/** What the curly apostrophe becomes under cp1252, where 0x80 is the euro sign. */
const CURLY_MANGLED_CP1252 = '\u00E2\u20AC\u2122';
/** What the curly apostrophe becomes under latin-1: a lead byte and two C1 controls. */
const CURLY_MANGLED_LATIN1 = '\u00E2\u0080\u0099';

const check = (value: string): string[] => mojibakeIn({ key: value });

describe('mojibakeIn', () => {
    it('leaves ordinary accented text alone', () => {
        expect(check(`Refus${E_ACUTE}`)).toEqual([]);
        expect(check(`L${CURLY}ordre`)).toEqual([]);
    });

    it('leaves a legitimate capital A-tilde alone', () => {
        // Portuguese uses it as a letter. Matching the lead byte followed by *anything* would flag
        // this, which is why the pattern requires a continuation byte after it.
        expect(check(`${A_TILDE_CAPITAL}GUA`)).toEqual([]);
        expect(check(`S${A_TILDE_CAPITAL}O PAULO`)).toEqual([]);
    });

    it('catches an accent mangled through latin-1', () => {
        expect(check(`Refus${E_ACUTE_MANGLED}`)).toEqual([`key: Refus${E_ACUTE_MANGLED}`]);
    });

    it('catches a curly quote mangled through cp1252', () => {
        expect(check(`L${CURLY_MANGLED_CP1252}ordre`)).toHaveLength(1);
    });

    it('catches a curly quote mangled through latin-1, which is only C1 controls', () => {
        // The case an earlier version missed: no euro sign to match on, just raw controls.
        expect(check(`L${CURLY_MANGLED_LATIN1}ordre`)).toHaveLength(1);
    });

    it('reports the key and the value, so the failure says which string', () => {
        expect(mojibakeIn({ good: 'fine', bad: E_ACUTE_MANGLED })).toEqual([`bad: ${E_ACUTE_MANGLED}`]);
    });

    it('says nothing about plain ASCII', () => {
        expect(mojibakeIn({ a: 'Remove this method', b: 'Add a tax' })).toEqual([]);
    });
});
