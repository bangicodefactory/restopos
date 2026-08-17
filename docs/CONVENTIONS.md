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
technique works and is worth keeping while writing a guard. What it must **not** be is the record of
whether a guard is covered, because it fails silently — three times across two sessions the edit
turned out not to change behaviour, and a green run reads as "the guard is safe".

```
npm run mutation      # Stryker over the money half of packages/domain
```

Stryker makes each mutation itself, verifies it differs from the original, and reports what
**survived** — a mutant no test killed. A survivor is not automatically a bug; it is a line where
the tests would not notice a change. Read each one and decide: write the test, or record why the
mutant is uninteresting.

Scope was set by measurement. The first run covered all of `packages/domain`: 25 minutes, and the
top of the survivor list was `receipt/build.ts` with 288 mutants no test covers, because it is print
layout. Narrowed to the arithmetic — decimals and rounding, pricelists and combo distribution, the
tax engine — the same run is **7 minutes locally, 15 in CI, and scores 78.99 % (86.13 % of covered
code)**. `break` is 75: measured, not guessed, and a ratchet rather than a target. Raise it when the
score clears it comfortably; never lower it to make a build pass.

`.github/workflows/mutation.yml` runs it on a PR touching `packages/domain`, nightly, and on demand.

A survivor is answered one of two ways, and the second is not a cop-out. Either write the test — the
corpus had `attributeExtra: "0"` in all 21 places it appeared, so a paid combo upgrade had never been
priced by either engine, and fixture `084` fixes that — or record why the mutant cannot be killed.
`combo.ts`'s empty-components guard is an early exit that returns the same `[]` either way; it
carries a `// Stryker disable next-line all:` with the reasoning, because the alternative was a
fixture asserting something unfalsifiable. Suppressing with a reason is honest; suppressing to move
a number is not.

**The PHP side is not covered yet — see BAN-511.** Pest's `--mutate` needs `mutates()` declared on
the test files to know which tests cover which class. Without that, `--everything` is required to generate any
mutants at all, and it disables the per-test mapping: every mutant re-runs all 575 tests against
SQLite. Scoped to just `App\Support\{Money,Pricing,Tax,Pos}` that ran for six hours and hit the
GitHub Actions ceiling without finishing. There is deliberately no `composer mutation` script: a
command that hangs for six hours, with the caveat in a doc file, is a trap rather than a tool.

Mutation testing pays where code is a pure function of its inputs. Where behaviour is a conversation
with a database, the hand-written guard tests are what has actually been finding the defects — and
this codebase has the record to show it.

## Documentation (BAN-517)

Three files answer three different questions, and keeping them apart is what stops any of them
rotting:

| File | Question | Churns |
|---|---|---|
| `docs/spec/02-features.md` | What does *Odoo* do? | Almost never — it is the parity reference |
| `docs/features.yml` | What have *we* built? | Every ticket |
| `docs/manual/**` | How does someone *use* it? | Whenever behaviour a user can see changes |

`npm run docs:check` enforces the joins between them, and CI runs it on every PR.

### The ledger

`docs/features.yml` records one entry per feature we have built:

```yaml
REG-208: { status: shipped, surface: user, manual: register/payments.md#paying-on-account }
```

- `status` — `shipped` | `partial` | `planned`. Absence means planned.
- `surface` — `user` if a cashier, manager, cook or guest can see it; `internal` otherwise.
  Internal features owe no manual page: "the server re-prices the line" is not something anyone
  reads about. **Nothing can check this claim**, and it is the one field that quietly shrinks the
  debt ceiling — flipping a feature to `internal` removes its obligation *and* lowers the count. A
  diff that changes `surface` deserves a second look for that reason alone.
- `manual` — a path under `docs/manual/`, optionally `#anchored`, or `todo`.

The page has to name the feature back, in its front-matter `features:` list. One-way links rot
silently — the ledger keeps pointing at a page that was rewritten to be about something else.

### The debt ratchet

There were 173 shipped user-facing features with no manual page when this was introduced.
Documenting all of them before the gate could protect anything would have meant the gate never
arrived, so `meta.manual_debt` records the number and the check fails if it *rises*. Write a page,
lower the number. It may only ever fall.

### What CI actually checks on a PR

1. Every ID in the ledger is a feature `02-features.md` defines. Twenty IDs were already being
   cited in source docblocks that turned out not to exist — mostly range endpoints like
   `BOF-030 … BOF-079` read as though they were features.
2. Every shipped, user-facing feature names a page — or is counted as debt.
3. Every ID a manual page claims is real, recorded, and not still `planned`.
4. **Behaviour that changed was documented.** A diff touching `app/`, `resources/js/`,
   `packages/domain/src/`, `routes/` or `database/migrations/` must also touch `docs/`. Tests and
   fixtures are exempt.
5. **A migration moved with `docs/spec/01-schema.md`.** This project already followed that rule on
   every ticket; it had simply never been written down or checked.
6. **A feature the diff claims is recorded.** Feature ids appearing on *added* lines under the
   watched trees must exist in `docs/features.yml`. Rules 1–5 could tell that *some* doc had moved
   and that the ledger was self-consistent; none of them noticed a feature shipping unrecorded,
   which is the thing this gate exists to prevent — BAN-434 annotated four in its source, recorded
   none, and passed green.

   Ranges are not claims: `REG-001 … REG-039` and `BOF-070…079` orient the reader, and twenty ids
   cited that way turned out never to have been defined at all. Only added lines count — re-touching
   a line that already cited an id is not a new feature.

   The rule has two halves and they are **not** equally waivable. *Cited but unrecorded* is
   documentation debt, waived with the opt-out like rules 4 and 5. *Cited but nowhere in
   `02-features.md`* is not a judgement call — it is an id that does not exist, and no opt-out
   clears it.

### The opt-out

Refactors, dependency bumps and CI fixes genuinely change no behaviour. Put `[skip docs]` **on a
line of its own** in the PR body (a reason may follow it on the same line), or add the `docs: none`
label. It waives rules 4, 5 and the *unrecorded* half of rule 6 — the ledger still has to be
internally consistent, and an id the spec does not define still fails — and the waiver is printed in
the log whether or not a rule ends up firing.

Keeping the undefined-id half hard is deliberate. The waiver answers "does this change owe
documentation"; it was never meant to answer "may this change name a feature that does not exist".
Waivable, `[skip docs]` would have been the documented way to reintroduce BAN-430 — a shipped test
suite asserting two ability names that existed nowhere, because nothing validated them.

The token must start the line because matching it anywhere meant any PR that *mentioned* the escape
hatch silently had no gate. This feature's own pull request described the opt-out twice in its
body; so would any reviewer quoting it.

Use it. A gate that fires on everything gets bypassed by reflex, and then it protects nothing.

### What this does not do

It enforces **coverage and referential integrity**. It cannot tell whether a manual page is *true*.
Accuracy is a reviewer's job, and the green tick is not evidence of it.

Rule 4 is also satisfied by touching *any* file under `docs/`, including one unrelated line in a
spec. That is deliberate — inferring which doc a given code change owes is guesswork, and a gate
that guesses wrong gets disabled. It asks "did you consider the docs?", not "are the docs right".

The run prints what it examined (`18 changed, 4 behaviour, 6 docs`) so a diff that resolved to
nothing — a shallow clone, a renamed default branch, a bad base ref — cannot look like a pass. It
looked like one three times while this was being built.
