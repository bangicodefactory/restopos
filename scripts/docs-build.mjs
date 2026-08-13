#!/usr/bin/env node
/**
 * Renders `docs/manual/` into a static site (BAN-517).
 *
 * Deliberately about a hundred lines of markdown-it rather than a documentation framework. The
 * obvious choice was VitePress, and it was measured rather than assumed: it pins `vite ^5.4.14`,
 * which resolves a *second* vite beside the repo's 6.x and brings three advisories with it
 * (`npm audit` went 6 → 8). An `overrides` entry onto vite 6 would not stick. markdown-it adds
 * none — and pinning js-yaml explicitly cleared one the repo already had, so the whole docs stack
 * leaves `npm audit` better than it found it.
 *
 * What is lost is search and a theme. What is kept is a page a cashier can read on a phone behind
 * the counter, and a build with nothing in it that needs watching.
 *
 *   npm run docs:build   → docs/.dist
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import MarkdownIt from 'markdown-it';

import { parseFrontMatter, slugify, uniqueId } from './docs-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'docs/manual');
const OUT = path.join(ROOT, 'docs/.dist');

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

// Anchor every heading so `manual: page.md#anchor` in the ledger is a link that actually lands.
// Per-render, because two pages may legitimately share a heading; two headings on *one* page may
// not, or the anchor the ledger points at lands on whichever came first.
let seen = new Map();

md.renderer.rules.heading_open = (tokens, i) => {
    const level = tokens[i].tag;
    const text = tokens[i + 1]?.content ?? '';
    const id = uniqueId(slugify(text), seen);

    return `<${level} id="${id}"><a class="anchor" href="#${id}">#</a>`;
};

function render(body) {
    seen = new Map();

    return md.render(body);
}

function pages(dir = SOURCE, prefix = '') {
    const found = [];

    for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;

        if (statSync(full).isDirectory()) found.push(...pages(full, rel));
        else if (name.endsWith('.md')) {
            const { data, body } = parseFrontMatter(readFileSync(full, 'utf8'));
            found.push({ rel, href: rel.replace(/\.md$/, '.html'), data, body });
        }
    }

    return found;
}

/** Group by folder, because the folders are the audiences. */
function sidebar(all, current) {
    const groups = new Map();

    for (const page of all) {
        const folder = page.rel.includes('/') ? page.rel.split('/')[0] : '';
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(page);
    }

    const label = (folder) =>
        ({ '': 'Start here', register: 'On the till', 'back-office': 'Back office', kitchen: 'Kitchen', 'self-order': 'Self-order' })[folder] ??
        folder.replace(/-/g, ' ');

    let html = '';

    for (const [folder, items] of groups) {
        html += `<p class="group">${escape(label(folder))}</p><ul>`;
        for (const page of items) {
            const depth = current.rel.split('/').length - 1;
            const href = '../'.repeat(depth) + page.href;
            const active = page.rel === current.rel ? ' class="active"' : '';
            html += `<li><a href="${href}"${active}>${escape(page.data.title ?? page.rel)}</a></li>`;
        }
        html += '</ul>';
    }

    return html;
}

function escape(value) {
    return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function layout({ page, all, css }) {
    const depth = page.rel.split('/').length - 1;
    const home = '../'.repeat(depth) + 'index.html';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.data.title ?? 'RestoPOS manual')} — RestoPOS</title>
<style>${css}</style>
</head>
<body>
<header>
  <a class="brand" href="${home}">RestoPOS <span>manual</span></a>
  <button id="menu" aria-label="Menu" aria-expanded="false">☰</button>
</header>
<div class="shell">
  <nav id="nav">${sidebar(all, page)}</nav>
  <main>${render(page.body)}</main>
</div>
<script>
  const b = document.getElementById('menu');
  const n = document.getElementById('nav');
  b.addEventListener('click', () => {
    const open = n.classList.toggle('open');
    b.setAttribute('aria-expanded', String(open));
  });
</script>
</body>
</html>
`;
}

// Sized for a phone held behind a counter and for a sheet of A4 pinned by the pass — both are how
// this actually gets read.
const CSS = `
:root { --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#fff; --accent:#1d4ed8; --soft:#f9fafb; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e5e7eb; --muted:#9ca3af; --line:#374151; --bg:#0b0f19; --accent:#93c5fd; --soft:#111827; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
header { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:1rem;
  padding:.75rem 1rem; border-bottom:1px solid var(--line); background:var(--bg); }
.brand { font-weight:700; text-decoration:none; color:var(--fg); }
.brand span { color:var(--muted); font-weight:400; }
#menu { margin-left:auto; font-size:1.25rem; background:none; border:0; color:var(--fg); cursor:pointer; }
.shell { display:flex; align-items:flex-start; max-width:64rem; margin:0 auto; }
nav { display:none; flex:0 0 15rem; padding:1.5rem 1rem; }
nav.open { display:block; }
nav .group { margin:1.25rem 0 .35rem; font-size:.75rem; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); }
nav ul { list-style:none; margin:0; padding:0; }
nav a { display:block; padding:.3rem 0; color:var(--fg); text-decoration:none; font-size:.95rem; }
nav a.active { color:var(--accent); font-weight:600; }
main { flex:1 1 auto; min-width:0; padding:1.5rem 1.25rem 5rem; }
main h1 { font-size:1.9rem; line-height:1.2; margin:.5rem 0 1rem; }
main h2 { font-size:1.35rem; margin:2.25rem 0 .5rem; padding-top:.5rem; border-top:1px solid var(--line); }
main h3 { font-size:1.1rem; margin:1.5rem 0 .35rem; }
main table { width:100%; border-collapse:collapse; margin:1rem 0; display:block; overflow-x:auto; }
main th, main td { border:1px solid var(--line); padding:.5rem .6rem; text-align:left; vertical-align:top; }
main th { background:var(--soft); }
main blockquote { margin:1.25rem 0; padding:.6rem 1rem; border-left:3px solid var(--accent);
  background:var(--soft); color:var(--muted); }
main code { background:var(--soft); padding:.1rem .3rem; border-radius:3px; font-size:.9em; }
main a { color:var(--accent); }
.anchor { float:left; margin-left:-1rem; width:1rem; text-decoration:none; color:transparent; }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor { color:var(--muted); }
@media (min-width:56rem) {
  #menu { display:none; }
  nav { display:block; position:sticky; top:3.5rem; }
}
@media print {
  header, nav, .anchor { display:none; }
  body { font-size:11pt; color:#000; background:#fff; }
  main { padding:0; }
}
`;

/** Mirror every non-markdown file into the output, preserving the tree. */
function copyAssets(dir = SOURCE, prefix = '') {
    let copied = 0;

    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;

        if (statSync(full).isDirectory()) {
            copied += copyAssets(full, rel);
        } else if (!name.endsWith('.md')) {
            const target = path.join(OUT, rel);
            mkdirSync(path.dirname(target), { recursive: true });
            cpSync(full, target);
            copied += 1;
        }
    }

    return copied;
}

function main() {
    if (!existsSync(SOURCE)) {
        console.error(`docs-build: ${SOURCE} does not exist.`);
        process.exit(1);
    }

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });

    const all = pages();

    for (const page of all) {
        const target = path.join(OUT, page.href);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, layout({ page, all, css: CSS }), 'utf8');
    }

    // Anything alongside the markdown — screenshots, mostly — ships as-is, at whatever depth it
    // sits. Copying only the root silently dropped `register/img/shot.png` and rendered a broken
    // image with no build error, which for a *user* manual is the most likely asset there is.
    const assets = copyAssets();

    console.log(`docs-build: ${all.length} page(s), ${assets} asset(s) → ${path.relative(ROOT, OUT)}`);
}

main();
