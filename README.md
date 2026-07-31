# RestoPOS

An offline-first restaurant Point of Sale — a from-scratch rewrite of Odoo 19's
`point_of_sale` + `pos_restaurant` (plus self-ordering, kitchen display and back-office) on
**Laravel 12 · Inertia v2 · React 19 · TypeScript · PWA**.

Everything Odoo does for a restaurant POS is in scope. Everything Odoo does *around* it —
double-entry accounting, stock valuation, CRM, HR, marketing — is deliberately not. The
migration analysis, the parity matrix and the architecture that follow from that choice are
in [`docs/`](docs/).

---

## What is here

Four front-ends share one domain layer and one database:

| App | URL | Runs | Purpose |
|---|---|---|---|
| **Register** | `/pos/{config}` | PWA, offline-capable | The cashier terminal: products, orders, payments, receipts, floor plan, split bills, tips |
| **Kitchen display** | `/kitchen/{display}` | PWA | Ticket board with stages, timers, category routing. (Odoo's KDS is Enterprise-only; here it is first-class.) |
| **Self-order** | `/menu/{token}` | PWA | QR menu, order-from-table, and kiosk mode |
| **Back-office** | `/` | Inertia SPA | Configuration, catalogue, floors, employees, orders, sessions, reporting |

Plus a **customer display** companion screen at `/pos/{config}/display`.

The register is the point of the whole exercise: after the initial bootstrap it runs entirely
from IndexedDB. Pull the network cable mid-service and it keeps taking orders, printing
receipts and firing tickets to the kitchen; when the link returns, an idempotent outbox
replays everything. Nothing blocks on the server except pairing and the first data load.

---

## Quick start

> For a step‑by‑step setup (including a no‑Postgres/no‑Redis dev stack), a full run of the
> configuration keys, and the **end‑to‑end order workflow** across all four surfaces, see
> [`docs/SETUP-AND-WORKFLOW.md`](docs/SETUP-AND-WORKFLOW.md).

### With Docker

```bash
cp .env.example .env
docker compose up -d
docker compose exec app php artisan key:generate
docker compose exec app php artisan migrate --seed
```

Then open <http://localhost:8000> and sign in as `admin@restopos.test` / `password`.

### Without Docker

Requires PHP 8.3+ (with `bcmath`), PostgreSQL 14+ (SQLite works for development), Node 20+.

```bash
composer install
npm install
cp .env.example .env
php artisan key:generate
php artisan migrate --seed
composer dev          # serve + queue + reverb + vite, all at once
```

> `composer install` resolves from Packagist normally. (The container this was built in could
> not reach Packagist, so dependencies were mirrored from GitHub by `tools/composer-mirror.py`;
> that mirror and its lockfile are not shipped — `_build-notes/` and `tools/VENDOR-NOTES.md`
> record how it worked, in case you ever need to build offline.)

### The demo restaurant

`php artisan migrate --seed` builds **Le Bistro Numérique**, a French-Moroccan bistro:
74 products across 15 categories with variants, combos and menus, 3 registers, 3 floors with
24 tables, 2 kitchen displays, 6 employees, France-style VAT (10% on-site / 20% alcohol /
5.5% takeaway) with a takeaway fiscal position, a Happy Hour pricelist, and ~126 historical
orders over 30 days across 41 sessions — including a live session with draft orders already
sitting on tables, so the register opens with something to look at.

The seed is deterministic: two runs produce byte-identical data.

---

## Architecture in one page

**Money is never a float.** Every monetary value is a decimal string on the wire, `decimal(16,4)`
in Postgres, a bcmath `Decimal` in PHP and a `Decimal` in TypeScript. This is not fastidiousness —
a compound VAT chain computed in binary floating point drifts, and a POS that disagrees with its
own ledger by a centime is a POS nobody trusts.

**The tax engine exists twice, on purpose.** `app/Support/Tax/TaxEngine.php` and
`packages/domain/src/tax/engine.ts` implement the same algorithm, because the register must show
a total while offline and the server must be the one that decides it. They are held together by
83 JSON fixtures in `tests/fixtures/tax/` that both suites read — same inputs, same expected
decimal strings, on both sides. Change one engine without the other and the build goes red.

**The server always recomputes.** A synced order's client-side totals are treated as a hint: if
they disagree with the server's recomputation the order still posts, but a `client_total_mismatch`
warning is recorded. The client is trusted for intent, never for arithmetic.

**Sync is idempotent on UUID.** Every client-created row — orders, lines, payments, courses —
carries a UUID minted on the terminal. `POST /api/pos/sync` upserts on it, rewrites create↔update
commands in both directions, reroutes orders whose session closed while they were queued into a
rescue session, and returns per-record results so one poisoned order cannot block the queue behind
it. The unique index on `uuid` is the real guard; everything else is ergonomics.

Full detail:

| Document | What it covers |
|---|---|
| [`docs/SETUP-AND-WORKFLOW.md`](docs/SETUP-AND-WORKFLOW.md) | Practical setup, configuration reference, the end‑to‑end order workflow, and troubleshooting |
| [`docs/spec/01-schema.md`](docs/spec/01-schema.md) | Every table, column, index and enum — 131 tables across 11 domains |
| [`docs/spec/02-features.md`](docs/spec/02-features.md) | 549 leaf features with stable IDs, priorities, complexity and parity notes |
| [`docs/spec/03-architecture.md`](docs/spec/03-architecture.md) | Offline data layer, sync protocol, realtime, printing, PWA, testing |
| [`docs/spec/05-api-contract.md`](docs/spec/05-api-contract.md) | Every endpoint, broadcast event and Inertia page with its props |
| [`docs/odoo-analysis/`](docs/odoo-analysis/) | The source analysis of the Odoo 19 modules all of the above was derived from |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Naming, layering and style rules |

---

## Project layout

```
app/
  Enums/               84 backed string enums, mirrored in packages/domain/src/enums.ts
  Models/<Domain>/     Catalog · Identity · Pos · Pricing · Restaurant · Kitchen · SelfOrder · Loyalty · Audit
  Services/            business logic (sync, sessions, kitchen, self-order, payments)
  Support/Tax/         the PHP tax engine
  Support/Pricing/     pricelist resolution
  Http/                Backoffice (Inertia) · Api/Pos · Api/Kitchen · Api/SelfOrder
  Events/              Reverb broadcast events
packages/domain/       framework-free TypeScript: tax, pricing, money, ESC/POS, receipts, barcode, sync wire types
resources/js/
  shared/              Dexie schema, sync clients, stores, auth, printing transports, UI primitives, i18n
  register/            the cashier PWA
  kitchen/             the kitchen display PWA
  selforder/           the self-order / kiosk PWA
  backoffice/          the Inertia admin app
database/migrations/   one migration per domain
database/seeders/      the demo restaurant
docs/                  specs and the Odoo analysis
```

---

## Testing

```bash
./vendor/bin/pest        # PHP: tax parity, sync idempotency, sessions, kitchen, self-order
npm run test             # TypeScript: domain, register, kitchen, self-order, back-office
npm run typecheck        # tsc --noEmit, strict
npx eslint resources/js packages
npx playwright test      # E2E (config present; specs to be written per docs/spec/03 §9)
```

The two suites that matter most are the tax parity fixtures (both languages, same expectations)
and the offline/sync tests, which drive the outbox against a stubbed transport and
`fake-indexeddb`.

---

## Where this stands

Foundation, data layer, server API, and all four front-ends are built and green. What is
deliberately still open is listed honestly in two places: §15 of
[`docs/spec/05-api-contract.md`](docs/spec/05-api-contract.md) lists endpoints not yet
implemented (refund caps, invoicing, loyalty redemption at the till, receipt email/SMS, real
payment-provider integration — the provider interface ships with a `NullProvider`), and §9 of
[`docs/spec/02-features.md`](docs/spec/02-features.md) carries the phased roadmap with exit
criteria per phase.

Feature IDs (`REG-012`, `RST-087`, `KDS-057`, …) are referenced from code comments, so any
behaviour you find in the source can be traced back to the Odoo behaviour it reproduces.
