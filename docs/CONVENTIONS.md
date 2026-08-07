# RestoPOS — build conventions (read before writing any code)

This project is a from-scratch rewrite of Odoo 19's `point_of_sale` + `pos_restaurant`
(+ `pos_self_order`, kitchen display, back-office) on **Laravel 12 + Inertia v2 + React 19 +
TypeScript + PWA**. The authoritative specs live in `docs/spec/`:

| File | Contents |
|---|---|
| `docs/spec/01-schema.md` | Complete relational schema, table by table |
| `docs/spec/02-features.md` | Feature parity matrix with stable IDs (REG-xxx, RST-xxx, KDS-xxx, SLF-xxx, BOF-xxx, XCT-xxx) |
| `docs/spec/03-architecture.md` | Technical architecture: offline data layer, sync protocol, tax engine, realtime, PWA |
| `docs/odoo-analysis/*.md` | The source analysis of the Odoo modules the spec was derived from |

## Naming

- **Tables**: `snake_case` plural (`pos_orders`, `restaurant_tables`, `prep_order_lines`).
- **Models**: `App\Models\<Domain>\<Singular>` — domains: `Catalog`, `Pricing`, `Pos`,
  `Restaurant`, `Kitchen`, `SelfOrder`, `Identity`. Example: `App\Models\Pos\Order`.
- **Enums**: PHP 8 backed string enums in `App\Enums\` (e.g. `App\Enums\OrderState`).
  The same literals are re-declared in `packages/domain/src/enums.ts` — they must match.
- **Money**: `decimal(16, 4)` in the DB; `string` on the wire; `Decimal` (bcmath) in PHP;
  `bigint` minor-units or `string` in TS. **Never** a JS `number` for a monetary value that
  will be persisted or compared.
- **Client-created rows** carry a `uuid` (`char(36)`, unique). The server `id` is authoritative
  once assigned; the client keys these records by `uuid` forever.

## Layering (server)

```
app/
  Enums/                 backed enums shared by DB casts + API
  Models/<Domain>/       Eloquent models, relations, casts, scopes only
  Services/<Domain>/     business logic (no HTTP, no Eloquent events)
  Support/Tax/           the PHP tax engine (mirrors packages/domain/src/tax)
  Support/Pricing/       pricelist resolution
  Http/Controllers/
      Backoffice/        Inertia page controllers
      Api/Pos/           register JSON API (bootstrap, sync, sessions)
      Api/Kitchen/       KDS API
      Api/SelfOrder/     public self-order API
  Http/Resources/        JSON serialisation for the bootstrap payload
  Events/                broadcast events (Reverb)
  Policies/
```

Controllers are thin: validate → call a Service → return a Resource. All money maths lives
in `Support/Tax` or `Support/Pricing` and nowhere else.

## Layering (client)

```
packages/domain/         framework-free TS: tax engine, pricing, enums, types, ESC/POS builder
resources/js/
  backoffice/            Inertia pages (React) for the admin app
  register/              cashier PWA (SPA island)
  kitchen/               kitchen display PWA (SPA island)
  selforder/             customer self-order PWA (SPA island)
  shared/                UI primitives, hooks, Echo setup used by more than one app
```

`packages/domain` must have **zero** runtime dependencies and must not import React, Dexie,
or anything from `resources/`. It is the piece that is unit-tested against the same JSON
fixtures as the PHP engine.

## The tax-parity rule

`app/Support/Tax/TaxEngine.php` and `packages/domain/src/tax/engine.ts` implement the same
algorithm. Both are driven by the fixture corpus in `tests/fixtures/tax/*.json`. Any change to
one must be accompanied by the same change to the other **and** a fixture that would have
failed before. Fixtures use decimal *strings* on both sides, never floats.

## Sync contract (summary — full detail in spec 03)

- `GET  /api/pos/bootstrap` → manifest + per-model payloads (ETag'd, config-scoped).
- `GET  /api/pos/delta?since=<watermark>` → changed rows + tombstones.
- `POST /api/pos/sync` → array of ORM-style commands, idempotent on `uuid`;
  returns per-record results so one bad order never blocks the rest of the queue.
- The server **always** recomputes totals; the client's numbers are a hint used for a
  mismatch warning, never trusted.

## Fixed entry points (every app agrees on these paths)

| App | Blade shell | Vite entry | URL |
|---|---|---|---|
| Back-office (Inertia) | `resources/views/app.blade.php` | `resources/js/backoffice/app.tsx` | `/` (auth) |
| Register PWA | `resources/views/register.blade.php` | `resources/js/register/main.tsx` | `/pos/{config}` |
| Kitchen display PWA | `resources/views/kitchen.blade.php` | `resources/js/kitchen/main.tsx` | `/kitchen/{display}` |
| Self-order PWA | `resources/views/selforder.blade.php` | `resources/js/selforder/main.tsx` | `/menu/{token}` |
| Customer display | `resources/views/customer_display.blade.php` | `resources/js/register/customer-display.tsx` | `/pos/{config}/display` |

The three PWA shells are **propless**: they must render identically for every user so the
service worker can precache the document. All state comes from IndexedDB + the bootstrap API.

Shared aliases (configured in `vite.config.ts` and `tsconfig.json`):

- `@domain/*` → `packages/domain/src/*`
- `@shared/*` → `resources/js/shared/*`
- `@register/*`, `@kitchen/*`, `@selforder/*`, `@backoffice/*` → the matching app folder

## Style

- PHP: `declare(strict_types=1);` everywhere, Pint (`laravel` preset), typed properties,
  constructor property promotion, no facades inside Services (inject).
- TS: `strict: true`, no `any` outside `*.d.ts`, named exports, `type` over `interface` for
  data shapes.
- Every table gets a migration in `database/migrations/`, grouped **one file per domain**
  (not one per table) with the domain prefix in the filename, e.g.
  `2025_01_01_000300_create_catalog_tables.php`.
- Every migration file lists at the top, in a comment, the tables it creates.

## Test hooks (`data-testid`)

E2E specs address **structure** by test id and **content** by what a human reads. The split is the
whole convention:

- **Test id** for anything a spec has to *find*: a tile, a row, a keypad key, a submit button. These
  are structural identity, and their visible labels are localised and state-dependent.
- **Role and text** for anything a spec *asserts*: a product name, a total, a warning. A cashier
  reads those, so a test that reads them is testing something real.

Selecting structure by label is what made the register suite unbuildable. Concrete examples, all of
them real:

- a table's accessible name is `"1 2 places"` — the number *and* its cover count, both translated
- the kitchen fire button reads `"Envoyer (1)"` with one course and `"Lancer le service 1"` with two
- `getByRole('button', { name: '1' })` matches a keypad key **and** table number 1

Rules:

- Name the id for the thing, not the screen: `table-tile`, `order-line`, `numpad-key`.
- Put the identifying value in its own `data-*` attribute rather than in the id, so a spec can
  address one instance: `data-table-number`, `data-course-index`, `data-key`, `data-line-uuid`.
- Expose a raw value next to a formatted one when a spec would otherwise parse currency or a date:
  `data-order-total` carries `24.2000` beside the rendered `24,20 €`.
- Add them when you build the component. Retrofitting means guessing which label was stable, and
  the guess is wrong on the state you did not have on screen at the time.

The helpers in `tests/e2e/support/register.ts` wrap these, so specs read `tableTile(page, 2)` rather
than repeating locator plumbing.

## Mutation testing (the money paths)

The suite proves the code does what the tests say. It does not prove the tests would notice if the
code stopped doing it. On the money paths that gap is the whole risk: a guard that has never been
executed by a test is indistinguishable from one that works, and every Phase 2 ticket found at
least one — a two-layer check where each layer covered for the other, a test that passed because
the *whole push* was failing, a sort guard that SQLite made unreachable.

Those were found by hand: revert the guard, run the suite, confirm a test fails, restore. That
technique works and it is worth keeping as a habit while writing a guard. What it must **not** be
is the record of whether the guard is covered, because it fails silently. Three times across two
sessions the edit turned out not to change behaviour — `attributeExtra($id, [])` returns `'0'`
either way; a `$cart = $held` edit while the fallback read `$held` by another path; once, a
"mutation" applied to a *test* rather than to the code. Each produced a green run, and a green run
reads as "the guard is safe".

So the record is a tool:

```
composer mutation           # Pest --mutate over app/Support/{Money,Pricing,Tax,Pos}
composer mutation:services  # …and over app/Services/Pos — on demand, it takes far longer
npm run mutation            # Stryker over the money half of packages/domain
```

Both make the mutation themselves, verify it differs from the original, and report what **survived**
— a mutant no test killed. A survivor is not automatically a bug; it is a line where the tests would
not notice a change. Read each one and decide: write the test, or record why the mutant is
uninteresting.

Scope is deliberate, and it was set by measurement rather than taste. The first Stryker run covered
all of `packages/domain`: 25 minutes, and the top of the survivor list was `receipt/build.ts` with
288 mutants no test covers — because it is print layout, not money. Narrowed to the arithmetic, the
same run is **7 minutes and scores 78.99 % (86.13 % of covered code)**, and every line in the report
is about what a customer is charged. A slow check with an unreadable report is a check that gets
deleted.

So neither tool is pointed at the whole codebase. They cover money: the decimal and rounding
primitives, pricelists and combo distribution, the tax engine, and on the PHP side the ingest,
pricing and session services. Replication, bootstrap and sequence code is excluded by name — a
survivor there is worth knowing and is not what this report is for.

Both default runs cover **arithmetic, not orchestration**, and that split was measured too. Pointing
Pest at `App\Services\Pos` — `OrderSyncService` alone is 2,500 lines, and every mutant re-runs a
575-test suite against a database — was still going after 23 minutes with no end in sight. It lives
in `composer mutation:services` for when someone wants it, and out of the PR path. The same call was
made on the TS side for `escpos` and `receipt`: a check that takes half an hour is a check somebody
turns off.

The PHP side uses **Pest's own `--mutate`**, not Infection. Infection drives `vendor/bin/phpunit`,
which Pest refuses outright, and no adapter bridges them — a fact that only surfaced by pushing to
CI. Pest 3+ has mutation testing built in, so there is no second config file and no extra
dependency.

The floors are measured, not guessed. Stryker breaks below 75 against a real 78.99. The PHP `--min`
is not set yet: generating PHP coverage needs pcov or Xdebug, neither was installed where this was
written, so the score is unknown until CI reports it — raising it is a separate, evidenced commit.

`.github/workflows/mutation.yml` runs both on a PR that touches those paths **or the tests that
cover them** — a PR that only edits a test can lower the score just as surely as one that edits the
code — nightly, and on demand. The `break` thresholds are a ratchet, not a target: raise them when
the real score clears them comfortably, and never lower one to make a build pass. A drop means a
guard arrived without a test that exercises it, which is the exact thing this exists to catch.
