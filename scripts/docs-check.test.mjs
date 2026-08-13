import { describe, expect, it } from 'vitest';

import { checkDocs, headingSlugs, isDoc, isWatched, parseFrontMatter, readSpecIds, slugify } from './docs-check.mjs';

/**
 * BAN-517 — the documentation gate.
 *
 * This script decides whether a pull request may merge, so it needs the same treatment as any other
 * guard in this repo: the rules are tested directly rather than by shelling out and reading exit
 * codes. `checkDocs` is pure over already-read inputs precisely so this file can exist.
 *
 * What is being pinned is *coverage and referential integrity*, which is all a machine can check.
 * Nothing here can tell whether a manual page is true — that is a reviewer's job, and it is worth
 * remembering when the green tick tempts you to skim the prose.
 */

const SPEC_IDS = new Set(['REG-001', 'REG-002', 'REG-208', 'XCT-101']);

function page(overrides = {}) {
    return { data: { title: 'A page', features: [] }, slugs: [], ...overrides };
}

/**
 * An empty ledger is itself an error (someone deleted the file), so the default here carries one
 * harmless internal entry — otherwise every test that does not care about features would be
 * asserting against that one message instead of its own rule.
 */
const HARMLESS = { 'XCT-101': { status: 'shipped', surface: 'internal' } };

function run({ features = HARMLESS, meta = { manual_debt: 0 }, manual = new Map(), ...rest } = {}) {
    return checkDocs({
        features: { meta, features },
        specIds: SPEC_IDS,
        manual,
        ...rest,
    });
}

describe('feature IDs have to be real', () => {
    it('rejects an ID the spec does not define', () => {
        // Twenty such IDs were already being cited in source docblocks — mostly range endpoints
        // like "BOF-030 … BOF-079" read as though they were features.
        const { errors } = run({ features: { 'REG-999': { status: 'shipped', surface: 'internal' } } });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('not a feature');
    });

    it('accepts one it does', () => {
        expect(run({ features: { 'XCT-101': { status: 'shipped', surface: 'internal' } } }).errors).toEqual([]);
    });

    it('rejects a status or surface it does not understand', () => {
        const { errors } = run({ features: { 'REG-001': { status: 'done', surface: 'sideways' } } });

        expect(errors.some((e) => e.includes('unknown status'))).toBe(true);
        expect(errors.some((e) => e.includes('unknown surface'))).toBe(true);
    });
});

describe('shipped user-facing features owe a manual page', () => {
    it('refuses one with no manual key at all', () => {
        const { errors } = run({ features: { 'REG-001': { status: 'shipped', surface: 'user' } } });

        expect(errors[0]).toContain('needs `manual:`');
    });

    it('asks nothing of an internal feature', () => {
        // "The server re-prices the line" is not something a cashier reads about.
        expect(run({ features: { 'REG-001': { status: 'shipped', surface: 'internal' } } }).errors).toEqual([]);
    });

    it('asks nothing of a feature that is only planned', () => {
        expect(run({ features: { 'REG-001': { status: 'planned', surface: 'user' } } }).errors).toEqual([]);
    });

    it('refuses a manual path that does not exist', () => {
        const { errors } = run({ features: { 'REG-001': { status: 'shipped', surface: 'user', manual: 'ghost.md' } } });

        expect(errors[0]).toContain('does not exist');
    });

    it('refuses an anchor with no matching heading', () => {
        // A deep link that 404s is worse than no link: it reads as though someone checked.
        const manual = new Map([['register/sessions.md', page({ data: { title: 'S', features: ['REG-001'] }, slugs: ['open-the-till'] })]]);
        const { errors } = run({
            features: { 'REG-001': { status: 'shipped', surface: 'user', manual: 'register/sessions.md#count-the-float' } },
            manual,
        });

        expect(errors[0]).toContain('no heading anchored');
    });

    it('accepts an anchor that resolves', () => {
        const manual = new Map([['register/sessions.md', page({ data: { title: 'S', features: ['REG-001'] }, slugs: ['open-the-till'] })]]);

        expect(
            run({
                features: { 'REG-001': { status: 'shipped', surface: 'user', manual: 'register/sessions.md#open-the-till' } },
                manual,
            }).errors,
        ).toEqual([]);
    });

    it('refuses a page that does not claim the feature back', () => {
        // One-way links rot silently: the ledger keeps pointing at a page rewritten to be about
        // something else, and nothing notices.
        const manual = new Map([['a.md', page({ data: { title: 'A', features: [] } })]]);
        const { errors } = run({
            features: { 'REG-001': { status: 'shipped', surface: 'user', manual: 'a.md' } },
            manual,
        });

        expect(errors[0]).toContain('does not list REG-001');
    });
});

describe('a page must not advertise coverage it does not have', () => {
    it('refuses front-matter naming an ID the spec does not define', () => {
        const manual = new Map([['a.md', page({ data: { title: 'A', features: ['REG-404'] } })]]);

        expect(run({ manual }).errors[0]).toContain('not a feature');
    });

    it('refuses documenting something the ledger does not record as built', () => {
        const manual = new Map([['a.md', page({ data: { title: 'A', features: ['REG-002'] } })]]);

        expect(run({ manual }).errors[0]).toContain('does not record as built');
    });

    it('refuses documenting something still planned', () => {
        const manual = new Map([['a.md', page({ data: { title: 'A', features: ['REG-002'] } })]]);
        const { errors } = run({ features: { 'REG-002': { status: 'planned', surface: 'user' } }, manual });

        expect(errors[0]).toContain('still `planned`');
    });

    it('requires a title', () => {
        const manual = new Map([['a.md', page({ data: { features: [] } })]]);

        expect(run({ manual }).errors[0]).toContain('needs a `title`');
    });
});

describe('the documentation-debt ratchet', () => {
    const todo = (n) =>
        Object.fromEntries(
            [...Array(n)].map((_, i) => [['REG-001', 'REG-002', 'REG-208'][i], { status: 'shipped', surface: 'user', manual: 'todo' }]),
        );

    it('allows debt up to the declared ceiling', () => {
        expect(run({ features: todo(2), meta: { manual_debt: 2 } }).errors).toEqual([]);
    });

    it('fails when debt rises above it', () => {
        // The point of the whole mechanism: nobody has to document 173 features before the gate can
        // protect the next one, but the number may only ever fall.
        const { errors } = run({ features: todo(3), meta: { manual_debt: 2 } });

        expect(errors[0]).toContain('rose to 3');
    });

    it('nudges you to bank the gain when debt falls', () => {
        const { warnings, errors } = run({ features: todo(1), meta: { manual_debt: 2 } });

        expect(errors).toEqual([]);
        expect(warnings[0]).toContain('lower it to 1');
    });

    it('counts only user-facing shipped features as debt', () => {
        const { debt } = run({
            features: {
                'REG-001': { status: 'shipped', surface: 'user', manual: 'todo' },
                'XCT-101': { status: 'shipped', surface: 'internal' },
                'REG-002': { status: 'planned', surface: 'user' },
            },
            meta: { manual_debt: 1 },
        });

        expect(debt).toBe(1);
    });
});

describe('which changed files owe documentation', () => {
    it('watches behaviour', () => {
        expect(isWatched('app/Services/Pos/OrderSyncService.php')).toBe(true);
        expect(isWatched('resources/js/register/screens/PaymentScreen.tsx')).toBe(true);
        expect(isWatched('database/migrations/2025_01_01_000107_create_order_tables.php')).toBe(true);
    });

    it('leaves tests and fixtures alone', () => {
        // Requiring a doc edit for a test rename trains everyone to reach for the opt-out, and an
        // opt-out reached for by reflex protects nothing.
        expect(isWatched('tests/Feature/Pos/PayLaterTest.php')).toBe(false);
        expect(isWatched('resources/js/register/screens/payment-prechecks.test.ts')).toBe(false);
        expect(isWatched('resources/js/register/domain/__fixtures__/catalog.ts')).toBe(false);
    });

    it('leaves unwatched trees alone', () => {
        expect(isWatched('.github/workflows/tests.yml')).toBe(false);
        expect(isWatched('composer.json')).toBe(false);
    });

    it('counts the doc trees as documentation', () => {
        expect(isDoc('docs/features.yml')).toBe(true);
        expect(isDoc('docs/manual/register/payments.md')).toBe(true);
        expect(isDoc('docs/spec/01-schema.md')).toBe(true);
        expect(isDoc('README.md')).toBe(false);
    });

    it('handles Windows separators', () => {
        expect(isWatched('app\\Services\\Pos\\OrderSyncService.php')).toBe(true);
        expect(isDoc('docs\\manual\\index.md')).toBe(true);
    });
});

describe('the diff gate', () => {
    it('fails a behaviour change that documents nothing', () => {
        const { errors } = run({ changedFiles: ['app/Services/Pos/OrderSyncService.php'] });

        expect(errors[0]).toContain('Behaviour changed');
    });

    it('passes once any doc moved with it', () => {
        const { errors } = run({ changedFiles: ['app/Services/Pos/OrderSyncService.php', 'docs/features.yml'] });

        expect(errors).toEqual([]);
    });

    it('says nothing about a test-only change', () => {
        expect(run({ changedFiles: ['tests/Feature/Pos/PayLaterTest.php'] }).errors).toEqual([]);
    });

    it('waives the gate on the opt-out, and records that it was waived', () => {
        const { errors, warnings } = run({ changedFiles: ['app/X.php'], skipDiffGate: true });

        expect(errors).toEqual([]);
        expect(warnings[0]).toContain('(waived)');
    });

    it('is not run at all when no diff was requested', () => {
        expect(run({ changedFiles: null }).errors).toEqual([]);
    });
});

describe('a migration moves with the schema doc', () => {
    it('fails a migration change on its own', () => {
        // The rule this project already followed on every ticket and had written down nowhere.
        const { errors } = run({ changedFiles: ['database/migrations/2025_01_01_000107_create_order_tables.php', 'docs/manual/index.md'] });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('without docs/spec/01-schema.md');
    });

    it('passes when the schema doc moved too', () => {
        const { errors } = run({
            changedFiles: ['database/migrations/2025_01_01_000107_create_order_tables.php', 'docs/spec/01-schema.md'],
        });

        expect(errors).toEqual([]);
    });

    it('is waived by the opt-out like the rest of the diff gate', () => {
        const { errors } = run({ changedFiles: ['database/migrations/x.php'], skipDiffGate: true });

        expect(errors).toEqual([]);
    });
});

describe('parsing helpers', () => {
    it('slugifies a heading the way an anchor is written', () => {
        expect(slugify('Count the opening float')).toBe('count-the-opening-float');
        // The slash is dropped, not turned into a separator — two spaces collapse to one hyphen.
        expect(slugify('Cash in / cash out')).toBe('cash-in-cash-out');
    });

    it('reads front-matter and leaves the body', () => {
        const { data, body } = parseFrontMatter('---\ntitle: X\nfeatures: [REG-001]\n---\n# Heading\n');

        expect(data.title).toBe('X');
        expect(data.features).toEqual(['REG-001']);
        expect(body).toContain('# Heading');
    });

    it('treats a page with no front-matter as all body', () => {
        const { data, body } = parseFrontMatter('# Just a heading\n');

        expect(data).toEqual({});
        expect(body).toContain('# Just a heading');
    });

    it('finds heading anchors at every level', () => {
        expect(headingSlugs('# One\n\ntext\n\n### Two words\n')).toEqual(['one', 'two-words']);
    });

    it('reads feature IDs out of the spec table', () => {
        const ids = readSpecIds('| REG-001 | Open register | ref | P0 | M | note |\n| not-a-row |\n| BOF-160 | Report | x | P1 | S | |');

        expect([...ids]).toEqual(['REG-001', 'BOF-160']);
    });
});
