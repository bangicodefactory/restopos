#!/usr/bin/env node
/**
 * The documentation gate (BAN-517).
 *
 * Two things had been true at once: the rule "update `docs/spec/01-schema.md` alongside the
 * migration" was followed on every ticket and written down in no file, and there was no record
 * anywhere of which of the 549 spec'd features actually exist. Both were held together by habit.
 *
 * **What this can enforce is coverage and referential integrity** — every shipped user-facing
 * feature names a manual page, every ID anyone cites is real, a migration moves with the schema
 * doc. **It cannot tell whether the prose is true.** Accuracy stays a review responsibility. Worth
 * saying plainly, because a green check that is mistaken for "the docs are correct" is worse than
 * no check at all.
 *
 * The decision is a pure function (`checkDocs`) over already-read inputs, with the file system and
 * git confined to `main()`. That is the house pattern for anything that gates a merge — the rules
 * are unit-tested directly rather than through a subprocess.
 *
 *   node scripts/docs-check.mjs                 # content rules only
 *   node scripts/docs-check.mjs --since=origin/master   # + the diff gate
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js-yaml 5 is pure ESM with named exports — there is no default export to destructure.
import { load as parseYaml } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FEATURES_FILE = 'docs/features.yml';
export const SPEC_FILE = 'docs/spec/02-features.md';
export const SCHEMA_DOC = 'docs/spec/01-schema.md';
export const MANUAL_DIR = 'docs/manual';

/** A change to any of these is a behaviour change until someone says otherwise. */
export const WATCHED = ['app/', 'resources/js/', 'packages/domain/src/', 'routes/', 'database/migrations/'];

/**
 * Paths that are watched-looking but are not behaviour.
 *
 * Tests and fixtures move constantly and describe nothing a user reads; requiring a doc edit for
 * them would train everyone to reach for the opt-out, and an opt-out reached for by reflex protects
 * nothing.
 */
export const WATCH_EXCEPTIONS = [/(^|\/)tests\//, /\.test\.[cm]?[jt]sx?$/, /__fixtures__\//, /\.spec\.[cm]?[jt]sx?$/];

/** Touching any of these counts as documenting the change. */
export const DOC_PATHS = ['docs/features.yml', 'docs/manual/', 'docs/spec/'];

/** The label that waives the diff rules. Structured, and applying it is a deliberate act. */
export const SKIP_LABEL = 'docs: none';

/**
 * Is the diff gate waived, and by what?
 *
 * The body token is **anchored to the start of a line**, and that is the whole point. Matching it
 * anywhere turned every PR that so much as *mentioned* the escape hatch into a PR with no gate —
 * including this feature's own, whose description documents the opt-out twice, and any review
 * comment quoting it. The failure was silent, because a waiver only announces itself when a rule
 * would otherwise have fired.
 *
 * A line may carry a reason after the directive; anything before it means the line is prose.
 *
 * @param {{body?: string, labels?: string}} context
 * @returns {{waived: boolean, reason: string|null}}
 */
export function parseSkip({ body = '', labels = '' } = {}) {
    const labelled = labels
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .includes(SKIP_LABEL);

    if (labelled) return { waived: true, reason: `the "${SKIP_LABEL}" label` };

    const directive = /^[ 	]*\[skip docs\][ 	]*(.*)$/im.exec(body);

    if (directive !== null) {
        const why = directive[1].trim();

        return { waived: true, reason: why === '' ? '[skip docs] on its own line' : `[skip docs] — ${why}` };
    }

    return { waived: false, reason: null };
}

/** GitHub's heading slug, near enough for anchors we author ourselves. */
export function slugify(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
}

/**
 * A heading id that is unique within one page.
 *
 * Two pages may legitimately share a heading; two headings on *one* page may not, or the anchor the
 * ledger points at lands on whichever came first. `seen` is mutated, so pass a fresh Map per page.
 *
 * @param {string} base   the slug
 * @param {Map<string, number>} seen
 */
export function uniqueId(base, seen) {
    const count = seen.get(base) ?? 0;

    seen.set(base, count + 1);

    return count === 0 ? base : `${base}-${count}`;
}

/**
 * Where a link in the source markdown points once rendered.
 *
 * Pages link to each other as `refunds.md`, which is right: that is what works when the manual is
 * read on GitHub, and the source is the primary artefact. The published site needs `.html`, and
 * nothing was rewriting them — every in-prose cross-link 404'd, including all five on the index,
 * which is the manual's main navigation.
 *
 * External and absolute links are left exactly as written.
 */
export function htmlHref(href) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;

    return href.replace(/\.md(?=$|[#?])/i, '.html');
}

/** Relative `.md` links a page makes, with any anchor stripped. */
export function markdownLinks(body) {
    return [...body.matchAll(/\]\(([^)\s]+\.md)(#[^)\s]*)?\)/g)].map((m) => m[1]);
}

/** Resolve a link relative to the page that makes it, as a manual-root-relative path. */
export function resolveLink(fromPage, href) {
    const parts = fromPage.split('/').slice(0, -1);

    for (const segment of href.split('/')) {
        if (segment === '.' || segment === '') continue;
        if (segment === '..') parts.pop();
        else parts.push(segment);
    }

    return parts.join('/');
}


/** Split `---\nyaml\n---\nbody` into its parts. Front-matter is optional; body always present. */
export function parseFrontMatter(source) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);

    if (match === null) return { data: {}, body: source };

    return { data: parseYaml(match[1]) ?? {}, body: match[2] };
}

export function headingSlugs(markdown) {
    return [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1]));
}

/** Is this changed path a behaviour change that owes documentation? */
export function isWatched(file) {
    const unix = file.replace(/\\/g, '/');

    if (WATCH_EXCEPTIONS.some((rule) => rule.test(unix))) return false;

    return WATCHED.some((prefix) => unix.startsWith(prefix));
}

export function isDoc(file) {
    const unix = file.replace(/\\/g, '/');

    return DOC_PATHS.some((prefix) => unix.startsWith(prefix));
}

/**
 * Every rule, over inputs someone else read.
 *
 * @param {object} input
 * @param {Record<string, any>} input.features   parsed `features.yml` (`meta` + `features`)
 * @param {Set<string>} input.specIds            IDs `02-features.md` actually defines
 * @param {Map<string, {data: object, slugs: string[]}>} input.manual  path (relative to docs/manual) => page
 * @param {string[]|null} input.changedFiles     null disables the diff gate
 * @param {boolean} input.skipDiffGate           the `[skip docs]` / `docs: none` opt-out
 * @returns {{errors: string[], warnings: string[], debt: number, diff: object|null}}
 */
export function checkDocs({ features, specIds, manual, changedFiles = null, skipDiffGate = false }) {
    const errors = [];
    const warnings = [];

    const entries = Object.entries(features?.features ?? {});
    const declaredDebt = Number(features?.meta?.manual_debt ?? 0);

    if (entries.length === 0) errors.push(`${FEATURES_FILE}: no features declared.`);

    let debt = 0;

    for (const [id, entry] of entries) {
        const where = `${FEATURES_FILE} [${id}]`;

        // An ID nobody validates is an ID that drifts — twenty were already being cited in source
        // docblocks that the spec never defined.
        if (!specIds.has(id)) {
            errors.push(`${where}: not a feature in ${SPEC_FILE}.`);
            continue;
        }

        const status = entry?.status ?? 'planned';
        const surface = entry?.surface ?? 'user';

        if (!['shipped', 'partial', 'planned'].includes(status)) {
            errors.push(`${where}: unknown status "${status}".`);
        }

        if (!['user', 'internal'].includes(surface)) {
            errors.push(`${where}: unknown surface "${surface}".`);
        }

        if (status === 'planned' || surface === 'internal') continue;

        const target = entry?.manual;

        if (target === undefined || target === null) {
            errors.push(`${where}: shipped and user-facing, so it needs \`manual:\` (or \`manual: todo\`).`);
            continue;
        }

        if (target === 'todo') {
            debt += 1;
            continue;
        }

        const [file, anchor] = String(target).split('#');
        const page = manual.get(file);

        if (page === undefined) {
            errors.push(`${where}: \`manual: ${target}\` points at ${MANUAL_DIR}/${file}, which does not exist.`);
            continue;
        }

        if (anchor !== undefined && anchor !== '' && !page.slugs.includes(anchor)) {
            errors.push(`${where}: ${file} has no heading anchored "#${anchor}".`);
        }

        // The page has to claim the feature too. One-way links rot silently: the ledger keeps
        // pointing at a page that was rewritten to be about something else.
        const claimed = (page.data.features ?? []).map(String);

        if (!claimed.includes(id)) {
            errors.push(`${where}: ${file} does not list ${id} in its front-matter \`features:\`.`);
        }
    }

    // The other direction: a page must not advertise coverage the ledger disagrees with.
    for (const [file, page] of manual) {
        for (const id of (page.data.features ?? []).map(String)) {
            if (!specIds.has(id)) {
                errors.push(`${MANUAL_DIR}/${file}: front-matter lists ${id}, which is not a feature in ${SPEC_FILE}.`);
                continue;
            }

            const entry = features?.features?.[id];

            if (entry === undefined) {
                errors.push(`${MANUAL_DIR}/${file}: documents ${id}, which ${FEATURES_FILE} does not record as built.`);
            } else if ((entry.status ?? 'planned') === 'planned') {
                errors.push(`${MANUAL_DIR}/${file}: documents ${id}, which is still \`planned\`.`);
            }
        }

        if (!page.data.title) {
            errors.push(`${MANUAL_DIR}/${file}: front-matter needs a \`title\`.`);
        }

        // A cross-link to a page that does not exist is a 404 on the published site, and the index
        // page is nothing but cross-links.
        for (const href of page.links ?? []) {
            const target = resolveLink(file, href);

            if (!manual.has(target)) {
                errors.push(`${MANUAL_DIR}/${file}: links to "${href}", which is not a page (resolved: ${target}).`);
            }
        }
    }

    // The ratchet. Nobody has to document 173 features before the gate can start protecting the
    // next one — but the number may only ever fall.
    if (debt > declaredDebt) {
        errors.push(
            `Undocumented user-facing features rose to ${debt}, above meta.manual_debt (${declaredDebt}). ` +
                `Write the page, or raise the ceiling deliberately and say why in the PR.`,
        );
    } else if (debt < declaredDebt) {
        warnings.push(`meta.manual_debt is ${declaredDebt} but only ${debt} remain — lower it to ${debt} to hold the gain.`);
    }

    let diff = null;

    if (changedFiles !== null) {
        const watched = changedFiles.filter(isWatched);
        const docs = changedFiles.filter(isDoc);

        if (watched.length > 0 && docs.length === 0) {
            const message =
                `Behaviour changed in ${watched.length} file(s) with no documentation change.\n` +
                `  e.g. ${watched.slice(0, 5).join(', ')}\n` +
                `  Update ${DOC_PATHS.join(', ')} — or say "[skip docs]" in the PR body / add the "docs: none" label.`;

            skipDiffGate ? warnings.push(`(waived) ${message}`) : errors.push(message);
        }

        // The rule this project already followed by habit, finally written down and checked.
        const migrations = changedFiles.filter((f) => f.replace(/\\/g, '/').startsWith('database/migrations/'));
        const schemaTouched = changedFiles.some((f) => f.replace(/\\/g, '/') === SCHEMA_DOC);

        if (migrations.length > 0 && !schemaTouched) {
            const message =
                `${migrations.length} migration(s) changed without ${SCHEMA_DOC}.\n` +
                `  ${SCHEMA_DOC} is the schema's source of truth; a column that exists in only one of them is a bug waiting.`;

            skipDiffGate ? warnings.push(`(waived) ${message}`) : errors.push(message);
        }

        diff = {
            changed: changedFiles.length,
            watched: watched.length,
            docs: docs.length,
            migrations: migrations.length,
        };
    }

    return { errors, warnings, debt, diff };
}

// ---------------------------------------------------------------- the IO half

function read(relative) {
    return readFileSync(path.join(ROOT, relative), 'utf8');
}

export function readSpecIds(markdown) {
    return new Set([...markdown.matchAll(/^\|\s*((?:REG|RST|KDS|SLF|BOF|XCT)-\d{3})\s*\|/gm)].map((m) => m[1]));
}

function readManual(dir = path.join(ROOT, MANUAL_DIR), prefix = '') {
    const pages = new Map();

    if (!existsSync(dir)) return pages;

    for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;

        if (statSync(full).isDirectory()) {
            for (const [k, v] of readManual(full, rel)) pages.set(k, v);
        } else if (name.endsWith('.md')) {
            const { data, body } = parseFrontMatter(readFileSync(full, 'utf8'));
            pages.set(rel, { data, slugs: headingSlugs(body), links: markdownLinks(body) });
        }
    }

    return pages;
}

function changedSince(ref) {
    const base = execFileSync('git', ['merge-base', ref, 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

    return execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function main(argv) {
    const since = argv.find((a) => a.startsWith('--since='))?.slice('--since='.length);

    // CI passes the PR body and labels through the environment; `[skip docs]` on its own line in a
    // local commit message works too, so the same escape hatch exists without GitHub in the loop.
    const skip = parseSkip({
        body: process.env.DOCS_SKIP_CONTEXT ?? '',
        labels: process.env.DOCS_SKIP_LABELS ?? '',
    });
    const skipDiffGate = argv.includes('--skip-diff') || skip.waived;

    let changedFiles = null;

    if (since !== undefined) {
        try {
            changedFiles = changedSince(since);
        } catch (error) {
            console.error(`docs-check: could not diff against "${since}" — ${error.message}`);
            process.exit(2);
        }
    }

    // Announced whether or not a rule ends up firing. A waiver that only surfaces when something
    // was actually waived is a waiver nobody notices was in force.
    if (skip.waived) console.log(`docs-check: diff rules waived by ${skip.reason}.`);

    const { errors, warnings, debt, diff } = checkDocs({
        features: parseYaml(read(FEATURES_FILE)),
        specIds: readSpecIds(read(SPEC_FILE)),
        manual: readManual(),
        changedFiles,
        skipDiffGate,
    });

    // What was actually examined. Without this a misconfigured base ref — a shallow clone, a
    // renamed default branch, a diff that resolved to nothing — produces output identical to a
    // real pass, and the gate looks green while checking air. That is not hypothetical: it
    // happened three times while this script was being reviewed.
    if (diff !== null) {
        console.log(
            `docs-check: diff vs ${since} — ${diff.changed} changed, ${diff.watched} behaviour, ` +
                `${diff.docs} docs, ${diff.migrations} migration(s).`,
        );

        if (diff.changed === 0) {
            console.warn(`warning: the diff against "${since}" was empty — the change gate checked nothing.`);
        }
    }

    for (const warning of warnings) console.warn(`warning: ${warning}`);

    if (errors.length > 0) {
        console.error(`\ndocs-check found ${errors.length} problem(s):\n`);
        for (const error of errors) console.error(`  ✗ ${error}`);
        console.error('');
        process.exit(1);
    }

    console.log(`docs-check: ok — ${debt} user-facing feature(s) still undocumented.`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
