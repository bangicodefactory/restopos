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
