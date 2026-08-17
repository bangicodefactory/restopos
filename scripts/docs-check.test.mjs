import { describe, expect, it } from 'vitest';

import {
    checkDocs,
    citedFeatureIds,
    headingSlugs,
    htmlHref,
    isDoc,
    isWatched,
    markdownLinks,
    parseFrontMatter,
    parseSkip,
    readSpecIds,
    resolveLink,
    slugify,
    uniqueId,
} from './docs-check.mjs';

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

describe('the opt-out has to be a directive, not a mention (review of #52)', () => {
    // The bug this exists for: the token was matched anywhere in the PR body, so a PR that merely
    // *described* the escape hatch silently had no gate. This feature's own description documents
    // it twice, and any reviewer quoting it would have done the same — while the waiver only
    // announces itself when a rule fires, so nobody would have noticed.
    it('ignores the token inside prose', () => {
        expect(parseSkip({ body: 'Say [skip docs] in the PR body to waive the diff rules.' }).waived).toBe(false);
        expect(parseSkip({ body: 'Why not [skip docs] here?' }).waived).toBe(false);
        expect(parseSkip({ body: '| `[skip docs]` | waives the last two |' }).waived).toBe(false);
    });

    it('honours it on a line of its own', () => {
        const { waived, reason } = parseSkip({ body: `chore: bump deps

[skip docs]` });

        expect(waived).toBe(true);
        expect(reason).toContain('own line');
    });

    it('lets the directive carry a reason', () => {
        const { waived, reason } = parseSkip({ body: '[skip docs] pure refactor, no behaviour change' });

        expect(waived).toBe(true);
        expect(reason).toContain('pure refactor');
    });

    it('honours the label, whitespace and neighbours notwithstanding', () => {
        expect(parseSkip({ labels: 'bug, docs: none ,frontend' }).waived).toBe(true);
        expect(parseSkip({ labels: 'DOCS: NONE' }).waived).toBe(true);
    });

    it('is not fooled by a label that merely contains the words', () => {
        expect(parseSkip({ labels: 'docs: none please, bug' }).waived).toBe(false);
        expect(parseSkip({ labels: 'needs docs' }).waived).toBe(false);
    });

    it('waives nothing by default', () => {
        expect(parseSkip().waived).toBe(false);
        expect(parseSkip({ body: 'Fixes the rounding bug.' }).waived).toBe(false);
    });
});

describe('the run reports what it examined', () => {
    // A misconfigured base ref used to produce output identical to a real pass. It happened three
    // times while this script was being reviewed, and each time the gate looked green while
    // checking nothing.
    it('counts the diff it judged', () => {
        const { diff } = run({
            changedFiles: ['app/A.php', 'tests/B.php', 'docs/features.yml', 'database/migrations/c.php', 'docs/spec/01-schema.md'],
        });

        expect(diff).toEqual({ changed: 5, watched: 2, docs: 2, migrations: 1, cited: 0 });
    });

    it('reports nothing when no diff was requested', () => {
        expect(run().diff).toBeNull();
    });

    it('reports an empty diff rather than passing silently', () => {
        expect(run({ changedFiles: [] }).diff).toEqual({ changed: 0, watched: 0, docs: 0, migrations: 0, cited: 0 });
    });
});

describe('heading ids are unique within a page', () => {
    it('leaves the first of a name alone and suffixes the rest', () => {
        // Otherwise a `manual: page.md#anchor` deep link lands on whichever heading came first.
        const seen = new Map();

        expect(uniqueId('cash', seen)).toBe('cash');
        expect(uniqueId('cash', seen)).toBe('cash-1');
        expect(uniqueId('cash', seen)).toBe('cash-2');
        expect(uniqueId('tips', seen)).toBe('tips');
    });

    it('starts over for a new page', () => {
        expect(uniqueId('cash', new Map())).toBe('cash');
    });
});

describe('cross-links survive publication (review of #52)', () => {
    // Pages link each other as `refunds.md` so the source reads correctly on GitHub. Nothing
    // rewrote them for the site, so every in-prose cross-link 404'd — including all five on the
    // index, which is the manual's entire navigation.
    it('rewrites a relative markdown link to html', () => {
        expect(htmlHref('refunds.md')).toBe('refunds.html');
        expect(htmlHref('register/sessions.md')).toBe('register/sessions.html');
        expect(htmlHref('../index.md')).toBe('../index.html');
    });

    it('keeps the anchor', () => {
        expect(htmlHref('refunds.md#giving-money-back')).toBe('refunds.html#giving-money-back');
    });

    it('leaves external and in-page links exactly as written', () => {
        expect(htmlHref('https://example.com/a.md')).toBe('https://example.com/a.md');
        expect(htmlHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
        expect(htmlHref('#count-the-opening-float')).toBe('#count-the-opening-float');
    });

    it('leaves anything that is not markdown alone', () => {
        expect(htmlHref('img/shot.png')).toBe('img/shot.png');
    });

    it('finds the links a page makes', () => {
        expect(markdownLinks('See [refunds](refunds.md) and [orders](../register/orders.md#x).')).toEqual([
            'refunds.md',
            '../register/orders.md',
        ]);
    });

    it('resolves a link against the page that makes it', () => {
        expect(resolveLink('register/orders.md', 'refunds.md')).toBe('register/refunds.md');
        expect(resolveLink('index.md', 'register/sessions.md')).toBe('register/sessions.md');
        expect(resolveLink('register/orders.md', '../index.md')).toBe('index.md');
    });

    it('fails a link to a page that does not exist', () => {
        const manual = new Map([['index.md', { data: { title: 'I', features: [] }, slugs: [], links: ['register/tips.md'] }]]);

        expect(run({ manual }).errors[0]).toContain('which is not a page');
    });

    it('passes a link that lands', () => {
        const manual = new Map([
            ['index.md', { data: { title: 'I', features: [] }, slugs: [], links: ['register/a.md'] }],
            ['register/a.md', { data: { title: 'A', features: [] }, slugs: [], links: [] }],
        ]);

        expect(run({ manual }).errors).toEqual([]);
    });
});

describe('a feature the diff claims has to be recorded (BAN-519)', () => {
    // The gate could tell that *some* doc had moved and that the ledger was internally consistent.
    // Neither noticed a feature shipping unrecorded, which is the thing it exists to prevent —
    // BAN-434 annotated four in its source, recorded none, and passed green.
    // The `---` line is not decoration: `git diff` always emits the pair, and since the review of
    // #57 the parser requires it, because `+++ ` on its own is also what an added line of code
    // beginning with `++ ` looks like. Fixtures that omitted it were testing a diff git never
    // produces.
    const diff = (...lines) => ['--- a/x', ...lines].join(String.fromCharCode(10));

    describe('reading the claims out of a diff', () => {
        it('takes an id from an added line, with the file that claims it', () => {
            expect(citedFeatureIds(diff('+++ b/app/X.php', '+ // REG-208 — pay later.'))).toEqual([
                { id: 'REG-208', file: 'app/X.php' },
            ]);
        });

        it('ignores a removed line — that is a feature going away, not arriving', () => {
            expect(citedFeatureIds(diff('+++ b/app/X.php', '- // REG-208 gone'))).toEqual([]);
        });

        it('ignores a range, which orients the reader rather than claiming anything', () => {
            // Twenty ids cited in source turned out to be exactly this, which is why the spec never
            // defined them: nothing was ever meant to define `BOF-079`.
            const cited = citedFeatureIds(
                diff(
                    '+++ b/app/X.php',
                    '+ * Session lifecycle & cash control (REG-001 … REG-039).',
                    '+ * Settings (SLF-001…SLF-019, BOF-070…079).',
                    '+ * Closing (REG-030…039).',
                ),
            );

            expect(cited).toEqual([]);
        });

        it('still reads a real claim on a line that also carries a range', () => {
            const cited = citedFeatureIds(diff('+++ b/app/X.php', '+ * Payments (REG-200 … REG-239). This does REG-208.'));

            expect(cited).toEqual([{ id: 'REG-208', file: 'app/X.php' }]);
        });

        it('takes several claims from one line', () => {
            expect(citedFeatureIds(diff('+++ b/a.ts', '+ // REG-209 and REG-212'))).toHaveLength(2);
        });

        it('does not repeat an id claimed twice in the same file', () => {
            expect(citedFeatureIds(diff('+++ b/a.ts', '+ // REG-208', '+ // REG-208 again'))).toHaveLength(1);
        });
    });

    describe('the rule', () => {
        const ledger = { 'REG-001': { status: 'shipped', surface: 'internal' } };

        it('fails a claim the ledger does not record', () => {
            const { errors } = run({
                features: ledger,
                changedFiles: ['app/X.php', 'docs/features.yml'],
                citedIds: [{ id: 'REG-208', file: 'app/X.php' }],
            });

            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('claims REG-208');
            expect(errors[0]).toContain('does not record');
        });

        it('passes a claim it does record', () => {
            const { errors } = run({
                features: ledger,
                changedFiles: ['app/X.php', 'docs/features.yml'],
                citedIds: [{ id: 'REG-001', file: 'app/X.php' }],
            });

            expect(errors).toEqual([]);
        });

        it('says so differently when the spec does not define the id at all', () => {
            // `REG-091` was cited in `ProductScreen.tsx` as the discount-barcode handler and does
            // not exist — the behaviour is REG-083. Either the id is wrong or the matrix is missing
            // a row, and those need different answers.
            const { errors } = run({
                features: ledger,
                changedFiles: ['app/X.php', 'docs/features.yml'],
                citedIds: [{ id: 'REG-404', file: 'app/X.php' }],
            });

            expect(errors[0]).toContain('does not define');
        });

        it('lets the opt-out defer a ledger entry, like the other diff rules', () => {
            const { errors, warnings } = run({
                features: ledger,
                changedFiles: ['app/X.php'],
                citedIds: [{ id: 'REG-208', file: 'app/X.php' }],
                skipDiffGate: true,
            });

            expect(errors).toEqual([]);
            expect(warnings.some((w) => w.includes('(waived)') && w.includes('REG-208'))).toBe(true);
        });

        it('still refuses an id the spec does not define, opt-out or not (review of #57)', () => {
            // Found reviewing this rule against its own pull request, which needed the opt-out for a
            // one-word comment fix and would have carried an invented id straight through with it.
            //
            // The waiver answers "does this change owe documentation". It was never meant to answer
            // "may this change name a feature that does not exist" — and inventing a name nothing
            // validates is the BAN-430 defect this rule exists to prevent. Waivable, it would have
            // been the documented way to reintroduce it.
            const { errors, warnings } = run({
                features: ledger,
                changedFiles: ['app/X.php'],
                citedIds: [{ id: 'REG-404', file: 'app/X.php' }],
                skipDiffGate: true,
            });

            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('claims REG-404');
            expect(errors[0]).toContain('does not define');
            expect(warnings.some((w) => w.includes('REG-404'))).toBe(false);
        });

        it('exempts a test file, exactly as rule 4 does (review of #57)', () => {
            // The rules disagreed about the same file. `addedSince` narrows the diff with the
            // `WATCHED` pathspec, which knows nothing of `WATCH_EXCEPTIONS`, so a test-only commit
            // printed `0 behaviour` on its summary line — rule 4 seeing correctly that nothing was
            // owed — and then failed on the file it had just called exempt.
            //
            // Not a hypothetical: the register tests cite ids constantly and 173 features are still
            // unrecorded, so adding coverage for any of them failed a gate whose own documentation
            // promises tests are exempt.
            const { errors } = run({
                features: ledger,
                changedFiles: ['resources/js/register/components/numpad.test.tsx'],
                citedIds: [{ id: 'REG-208', file: 'resources/js/register/components/numpad.test.tsx' }],
            });

            expect(errors).toEqual([]);
        });

        it('exempts a fixture even for an id the spec does not define', () => {
            // The unwaivable half has to respect the exemption too, or a fixture naming a made-up
            // id becomes a build failure with no escape hatch at all.
            const { errors } = run({
                features: ledger,
                changedFiles: ['resources/js/register/domain/__fixtures__/catalog.ts'],
                citedIds: [{ id: 'REG-404', file: 'resources/js/register/domain/__fixtures__/catalog.ts' }],
                skipDiffGate: true,
            });

            expect(errors).toEqual([]);
        });

        it('counts only the claims it examined', () => {
            const { diff: summary } = run({
                features: ledger,
                changedFiles: ['app/X.php'],
                citedIds: [
                    { id: 'REG-001', file: 'app/X.php' },
                    { id: 'REG-208', file: 'tests/Feature/XTest.php' },
                ],
            });

            expect(summary.cited).toBe(1);
        });

        it('asks nothing when no diff was requested', () => {
            expect(run({ features: ledger, citedIds: [{ id: 'REG-208', file: 'app/X.php' }] }).errors).toEqual([]);
        });

        it('counts the claims it examined', () => {
            const { diff: summary } = run({
                features: ledger,
                changedFiles: ['app/X.php', 'docs/features.yml'],
                citedIds: [{ id: 'REG-001', file: 'app/X.php' }],
            });

            expect(summary.cited).toBe(1);
        });
    });
});

describe('the diff header, when a line of code looks like one (review of #57)', () => {
    it('does not lose a claim to an added line beginning with "++ "', () => {
        // `++ $i;` at column 0 arrives in a unified diff as `+++ $i;`. Matching `+++ ` on the prefix
        // alone took that for a file header, set the current file to `$i;`, and — because that is
        // not a watched path — dropped every id after it in the hunk without a word.
        const diff = [
            '--- a/app/Counter.php',
            '+++ b/app/Counter.php',
            '@@ -1,0 +1,3 @@',
            '+++ $i;',
            '+// REG-208 pay later',
        ].join('\n');

        expect(citedFeatureIds(diff)).toEqual([{ id: 'REG-208', file: 'app/Counter.php' }]);
    });

    it('still follows a real header across several files', () => {
        const diff = [
            '--- a/app/A.php',
            '+++ b/app/A.php',
            '@@ @@',
            '+// REG-001',
            '--- a/app/B.php',
            '+++ b/app/B.php',
            '@@ @@',
            '+// REG-002',
        ].join('\n');

        expect(citedFeatureIds(diff)).toEqual([
            { id: 'REG-001', file: 'app/A.php' },
            { id: 'REG-002', file: 'app/B.php' },
        ]);
    });
});
