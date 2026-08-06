# Spec 03 — Technical Architecture

**Project**: Odoo 19 POS → Laravel + React rewrite
**Status**: Design spec, normative. Where this document says MUST/SHOULD it is a build constraint.
**Companions**: `01-pos-backend.md`, `02-pos-frontend.md`, `03-pos-restaurant.md`, `04-self-order.md`, `05-backoffice-aux.md` (source inventories of the system being replaced).

**Fixed stack** (not up for debate in this document):

| Layer | Choice |
|---|---|
| Server | Laravel 12, PHP 8.3+ |
| Server-rendered UI | Inertia.js v2 + React 19 + TypeScript |
| Build | Vite 6 |
| Styling | TailwindCSS 4 |
| Offline clients | PWA — `vite-plugin-pwa` (Workbox, `injectManifest` mode) |
| Database | PostgreSQL 16 |
| Realtime | Laravel Reverb |
| API / device auth | Laravel Sanctum |
| Queues / jobs | Laravel Horizon + Redis |

---

## Table of contents

1. [Application topology](#1-application-topology)
2. [Auth & identity](#2-auth--identity)
3. [The offline-first data layer](#3-the-offline-first-data-layer)
4. [Pricing & tax engine](#4-pricing--tax-engine)
5. [Realtime](#5-realtime)
6. [Sequences & references](#6-sequences--references)
7. [Printing & hardware](#7-printing--hardware)
8. [PWA specifics](#8-pwa-specifics)
9. [Testing strategy](#9-testing-strategy)
10. [Project structure](#10-project-structure)
11. [Deployment & ops](#11-deployment--ops)
12. [Appendix — decision log](#12-appendix--decision-log)

---

## 0. Architectural thesis

Odoo's POS is a **single Owl SPA that pretends to be a page of the web client**, with a hand-rolled client ORM (`related_models`), an IndexedDB mirror, and RPC into the generic ORM endpoint. Its two structural virtues are worth keeping and its three structural vices are worth discarding.

**Keep:**
1. UUID-first identity for anything the client can create offline; server ids are a *late-bound* attribute.
2. A single tax/pricing algorithm expressed twice (server + client) that must agree to the cent.
3. Server-authoritative recomputation on ingest — the client's numbers are a *proposal*.

**Discard:**
1. Generic ORM-over-RPC as the sync transport. We use explicit, versioned REST endpoints with typed contracts.
2. A client "mini-ORM" reconstructed at runtime from server-sent relation metadata. We ship a **compile-time** TypeScript domain model. Types are known at build time; there is no reason to discover them at boot.
3. One monolithic bootstrap RPC returning every model. We use a manifest + per-model paginated fetch so loading is resumable, cacheable, and observable.

The organising principle for the whole system:

> **The register is an offline application that occasionally talks to a server. Everything else is a web application.**

Every architectural decision below follows from taking that sentence literally.

---

## 1. Application topology

### 1.1 The four front-ends

| App | Audience | Delivery | Offline | Auth | Route prefix |
|---|---|---|---|---|---|
| **Back-office** | Managers, admins | Inertia v2 pages (SSR-capable) | No | Session (web guard) | `/` |
| **Register** | Cashiers, waiters | SPA island, precached shell | **Full** — must cold-boot with no network | Device token + employee PIN | `/register/*` |
| **Kitchen display (KDS)** | Kitchen staff | SPA island, precached shell | Degraded (queue view from cache, no new tickets) | Device token | `/kds/*` |
| **Self-order / kiosk** | Customers | SPA island, precached shell | Menu browsing offline; ordering requires network | Config token / table token / kiosk device token | `/self/*` |

A fifth, trivial surface: the **customer display** (`/display/*`) — a passive render target, no auth beyond a device-scoped token, driven by `BroadcastChannel` locally or Reverb remotely. It is not a separate app in the build sense; it is a route inside the register bundle plus a standalone entry so it can run on a second machine.

### 1.2 Why register/KDS/self-order are SPA islands, not Inertia pages

Inertia's contract is: *a navigation is an HTTP request that returns page props.* That is exactly the wrong contract for a register.

Concretely, five things break:

1. **Cold boot with no network.** A cashier opens the till at 07:00; the venue's uplink is down. An Inertia page needs `GET /register/3` to return HTML with `data-page` props. A service worker can serve a *cached* HTML response, but then the props are stale by an unbounded amount and there is no coherent story for "which config/session/employee do these props describe". An SPA shell has no props: it is a static `index.html` + JS bundle, and *all* state comes from IndexedDB. Precaching a static shell is a solved problem; precaching a props-bearing document is not.
2. **Navigation must be free.** Product screen → payment screen → receipt screen happens hundreds of times per shift, each transition sub-16ms. Inertia v2 partial reloads still round-trip. A client router (`react-router` v7 in `createBrowserRouter` mode, or a hand-rolled reducer router) does not.
3. **State outlives navigation.** The in-flight order, the number buffer, the payment terminal socket, the scanner listener, the scale poller — all must survive screen changes. Inertia remounts the page component on every visit; `preserveState` is a per-visit escape hatch, not an architecture.
4. **Ownership of truth is inverted.** In Inertia the server owns the page state. In the register the *client* owns the order until it is synced. Modelling that with server-returned props means constantly fighting the framework.
5. **Auth differs.** Register/KDS/kiosk authenticate with Sanctum bearer tokens held in IndexedDB, not session cookies, because they are long-lived unattended devices and because the self-order/kiosk surfaces are anonymous. Inertia assumes cookie-session.

The back-office is the opposite case in every respect — CRUD over paginated lists, permissioned per request, always online, benefits enormously from Inertia v2's deferred props, prefetching, and `WhenVisible` infinite scroll. So it stays pure Inertia.

**The shells.** Each SPA is served by a thin Blade view with no dynamic data whatsoever:

```php
// routes/web.php
Route::get('/register/{any?}', fn () => view('shells.register'))->where('any', '.*')->name('shell.register');
Route::get('/kds/{any?}',      fn () => view('shells.kds'))->where('any', '.*');
Route::get('/self/{any?}',     fn () => view('shells.self'))->where('any', '.*');
Route::get('/display/{any?}',  fn () => view('shells.display'))->where('any', '.*');
```

```blade
{{-- resources/views/shells/register.blade.php --}}
<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
  <link rel="manifest" href="/manifests/register.webmanifest">
  <meta name="theme-color" content="#0f172a">
  @viteReactRefresh
  @vite('resources/js/apps/register/main.tsx')
</head>
<body class="h-full overscroll-none select-none"><div id="root" class="h-full"></div></body>
</html>
```

No `@inertia`, no props, no CSRF token in the document (bearer auth), no user data. That document is byte-identical for every device and every tenant, which is what makes it precacheable.

### 1.3 Routing scheme

**Server routes** split into three files:

```
routes/web.php    → Inertia back-office + the four SPA shells + public self-order landing
routes/api.php    → /api/v1/* — token-authenticated JSON for register, KDS, kiosk
routes/public.php → /pos-self/* + /t/{token} (table QR) + /r/{token} (receipt portal) — unauthenticated, throttled
routes/channels.php → Reverb channel authorization
```

**API versioning**: `/api/v1/...` in the path. Registers in the field may lag the server by days (an offline device that has not synced). The v1 surface MUST be additive-only; a breaking change means `/api/v2` served alongside for at least one release cycle, and the bootstrap manifest carries `min_client_version` so an out-of-date register can refuse to open a session and tell the manager to update instead of corrupting data.

**Client routes** (register, illustrative):

```
/register/                      → boot / device pairing
/register/login                 → employee picker + PIN
/register/floor                 → restaurant floor plan (if enabled)
/register/order/:orderUuid      → product screen
/register/order/:orderUuid/pay  → payment screen
/register/order/:orderUuid/receipt
/register/order/:orderUuid/split
/register/tickets               → order list
/register/session/close
/display                        → customer display (same bundle, separate entry)
```

Order uuid in the URL, exactly like Odoo — it makes "restore the screen this order was on" trivial and makes deep-links from the ticket list work.

### 1.4 Code sharing between the four front-ends

A pnpm/npm **workspace inside `resources/js/`** with real package boundaries, not folder conventions. Boundaries that are only conventions get violated by the second sprint.

```
resources/js/packages/
  domain/        # zero-dependency: types, tax engine, pricing, ESC/POS builder, sequence, money
  data/          # Dexie schema, sync engine, HTTP client, Reverb client   (depends: domain)
  ui/            # design system: Button, Numpad, Dialog, Money, ProductCard (depends: domain)
  hardware/      # printers, scanner, scale, drawer, customer-display transport (depends: domain)
resources/js/apps/
  backoffice/    # Inertia pages          (depends: ui, domain)
  register/      # SPA                    (depends: domain, data, ui, hardware)
  kds/           # SPA                    (depends: domain, data, ui)
  selforder/     # SPA                    (depends: domain, data, ui, hardware)
  display/       # SPA                    (depends: domain, ui)
```

Enforced by `package.json` `workspaces` + TS project references + an ESLint `no-restricted-imports` rule forbidding `apps/*` → `apps/*` imports and `packages/domain` → anything.

`packages/domain` is the crown jewel: it is pure, synchronous, dependency-free TypeScript (no React, no Dexie, no fetch). That is what makes the tax engine testable under Vitest in milliseconds and what lets the same code run inside a web worker if we ever need it.

**Sharing with PHP.** Two artifacts cross the language boundary:
- `packages/domain/src/generated/api-types.ts` — generated from Laravel via `spatie/laravel-typescript-transformer` on DTOs, committed to the repo, CI-verified fresh.
- `resources/tax-fixtures/*.json` — the tax parity corpus (§4.3), consumed by both Pest and Vitest.

### 1.5 Build topology

Three PWA builds + one classic build, from one Vite config with mode switching:

```ts
// vite.config.ts  (excerpt)
const APPS = {
  backoffice: { entry: 'resources/js/apps/backoffice/main.tsx', pwa: false },
  register:   { entry: 'resources/js/apps/register/main.tsx',   pwa: { scope: '/register/', shell: '/register/' } },
  kds:        { entry: 'resources/js/apps/kds/main.tsx',        pwa: { scope: '/kds/',      shell: '/kds/' } },
  selforder:  { entry: 'resources/js/apps/selforder/main.tsx',  pwa: { scope: '/self/',     shell: '/self/' } },
  display:    { entry: 'resources/js/apps/display/main.tsx',    pwa: false },
}
```

Each PWA app gets **its own service worker at its own scope** (`/register/sw.js`, `/kds/sw.js`, `/self/sw.js`). Rationale: a customer's phone scanning a table QR must not precache the 2 MB register bundle, and a register update must not invalidate the kiosk's cache. Shared chunks resolve to identical URLs under `/build/assets/`, so the HTTP cache is shared even though the precache manifests are per-scope. The duplication costs disk on staff devices, which have it.

Back-office and display are ordinary Vite entries with no SW.

---

## 2. Auth & identity

Five distinct principals. Conflating any two of them is the classic failure mode in POS systems.

| Principal | What it proves | Lifetime | Mechanism |
|---|---|---|---|
| **User** | A back-office human | Session | Laravel session, `web` guard |
| **Device** | This physical terminal is enrolled | Until revoked | Sanctum personal access token |
| **Employee** | Who is at the till right now | Minutes–hours, offline-verifiable | PIN/badge verified locally against a device-scoped verifier |
| **Table** | Bearer scanned a specific table's QR | Until QR rotation | Opaque table token in URL |
| **Order** | Bearer created/owns a specific order | Order lifetime | Per-order capability token (uuid) |

### 2.1 Back-office users

Standard Laravel: `users` table, `web` guard, Fortify or hand-rolled login, 2FA for `admin` role. Inertia shares the user + abilities via a shared prop:

```php
// app/Http/Middleware/HandleInertiaRequests.php
public function share(Request $request): array
{
    return [
        ...parent::share($request),
        'auth' => fn () => $request->user() ? [
            'user' => UserData::from($request->user()),
            'abilities' => $request->user()->abilities(),   // string[]
        ] : null,
        'flash' => fn () => ['success' => $request->session()->get('success')],
    ];
}
```

Users are **not** cashiers. A user may *also* be an employee (`employees.user_id` nullable FK) but the register never authenticates a `User`.

### 2.2 Device registration (Sanctum)

Devices are first-class records, because sequence namespacing (§6), printer bindings, and audit trails all hang off them.

```
pos_devices
  id                uuid  pk
  pos_config_id     fk
  name              string          -- "Bar terminal 2"
  kind              enum(register, kds, kiosk, display)
  device_seq        int             -- small integer, unique per config, used in order refs
  secret_hash       string          -- argon2id of the device secret (see 2.3)
  last_seen_at      timestamptz
  app_version       string
  revoked_at        timestamptz null
  created_by_user_id fk null
```

**Pairing flow** (no typing of long tokens on a tablet):

1. Manager in back-office: *Devices → Add device* → server creates a `pos_pairing_codes` row: 8-char code, `pos_config_id`, `kind`, TTL 10 minutes, single-use. Displayed as text **and** as a QR.
2. Device (fresh install of `/register/`) shows a pairing screen; operator types the code or scans the QR.
3. `POST /api/v1/devices/pair` `{code, kind, hardware_fingerprint, app_version}` → creates `pos_devices` row, allocates `device_seq`, returns:

```jsonc
{
  "device": { "id": "0f8b…", "name": "Bar terminal 2", "device_seq": 3, "kind": "register" },
  "token": "12|8f2c…",                    // Sanctum plainTextToken — shown once
  "device_secret": "b3e1…",               // 32 bytes hex — used for offline PIN verifiers
  "config_id": 3,
  "server_time": "2026-07-28T09:12:44.512Z",
  "min_client_version": "1.4.0"
}
```

4. Client stores `{token, device_secret, device_id}` in IndexedDB (**not** `localStorage`: localStorage is synchronous, string-only, more readily scraped by injected script, and — critically — cleared by "clear site data" flows that Workbox users hit; IndexedDB survives alongside the rest of the offline dataset and is atomic with it).

Token abilities per kind:

```php
$abilities = match ($kind) {
    'register' => ['pos:sync', 'pos:session', 'pos:catalog', 'pos:print', 'pos:realtime'],
    'kds'      => ['pos:catalog', 'pos:kds', 'pos:realtime'],
    'kiosk'    => ['pos:catalog', 'pos:selforder', 'pos:realtime'],
    'display'  => ['pos:realtime'],
};
$device->createToken("device:{$device->id}", $abilities, expiresAt: null);
```

Middleware stack for `/api/v1`: `auth:sanctum` → `EnsureTokenIsDevice` (resolves `$request->device()`, rejects revoked) → `abilities:...` per route group → `TouchDeviceLastSeen` (queued, not inline).

**Revocation.** Deleting a device in back-office revokes its tokens *and* pushes `device.revoked` on the config channel so the terminal wipes local data on next connection. An offline revoked device continues working until it reconnects — that is unavoidable and correct: a till mid-shift must not brick itself. Compensating control: the sync endpoint rejects pushes from revoked devices with `410 Gone` and the orders are surfaced in a back-office "quarantined orders" queue rather than lost.

### 2.3 Employee login inside the register (offline, no round trip)

Requirement: switching cashier must take <100 ms with the network unplugged, hundreds of times a shift.

**Data.** The bootstrap payload includes, for each employee available on this config:

```jsonc
{
  "id": 17,
  "name": "Amina B.",
  "avatar_url": "/storage/emp/17.webp",
  "role": "cashier",                    // cashier | supervisor | manager
  "abilities": ["order.create", "order.discount.line", "…"],
  "pin_verifier": "9c4e…",              // HMAC-SHA256(device_secret, "pin:" || employee_id || ":" || pin)
  "badge_verifier": "01af…",            // HMAC-SHA256(device_secret, "badge:" || employee_id || ":" || badge_code)
  "badge_prefix": "E17"                 // optional, lets us skip HMAC over all employees on a scan
}
```

Verifiers are computed **server-side, per device**, using that device's `device_secret`. The plaintext PIN is never sent; the PIN hash from the `employees` table is never sent either.

**Verification** in the client:

```ts
// packages/domain/src/auth/pin.ts
export async function verifyPin(
  employees: EmployeeAuthRecord[],
  deviceSecret: CryptoKey,          // imported once at boot, non-extractable
  employeeId: number,
  pin: string,
): Promise<boolean> {
  const emp = employees.find(e => e.id === employeeId);
  if (!emp) return false;
  const mac = await hmacHex(deviceSecret, `pin:${employeeId}:${pin}`);
  return timingSafeEqualHex(mac, emp.pin_verifier);
}
```

`device_secret` is imported at boot via `crypto.subtle.importKey(..., extractable: false)` and the raw bytes are then dropped from IndexedDB in favour of the non-extractable `CryptoKey` (structured-cloneable, storable in IDB). This means a stolen IndexedDB dump does not yield the HMAC key — only an attacker executing code *in the origin* can use it.

**Threat model, stated honestly.** A 4–6 digit PIN verified offline is brute-forceable by anyone with code execution on the device (10⁶ HMACs ≈ seconds). This is inherent to *any* offline PIN scheme, Odoo's included. Therefore:

- PIN is an **attribution** control ("who rang this up"), not an authorization boundary.
- Anything with real financial consequence — voiding a paid order, cash-drawer open without a sale, discount above threshold, closing the session with a variance over the authorized difference, price override when `restrict_price_control` — requires a **manager approval**, which is:
  - **online**: `POST /api/v1/approvals` with manager PIN → server verifies against `employees.pin_hash` (argon2id) → returns a signed, short-TTL approval token recorded in `pos_approvals`;
  - **offline**: locally verified manager PIN, action allowed, and an `approval` record is queued with `verified: 'offline'` and synced. Back-office shows offline approvals in an audit report. Managers can disable offline approval per-config (`allow_offline_manager_override`), in which case those actions are simply blocked while offline.
- PIN attempts are rate-limited client-side (5 failures → 30 s lockout per employee, persisted so a reload does not reset it) and every failure is queued as an audit event.

**Badge login.** Barcode/RFID badges route through the same scanner pipeline: a scan matching the `cashier` barcode rule computes `HMAC(device_secret, "badge:<id>:<code>")`. Since we do not know the employee id from the code alone, we either (a) iterate all employees (fine: <200 HMACs, ~1 ms) or (b) use `badge_prefix` embedded in the badge to narrow to one. Implement (a); it is simpler and fast enough.

**Session storage.** Active employee is held in memory + mirrored to IndexedDB (`kv.active_employee`) so a crash/reload restores the cashier without a re-PIN, with an idle timeout (config `employee_idle_logout_seconds`, default 300) after which the lock screen returns.

### 2.4 Self-order tokens

Three tiers, straight from Odoo's model (§04 report §4.3), tightened:

| Token | Where | Format | Rotates |
|---|---|---|---|
| Config token | `/self/{configId}?t=<token>` | 22-char base62 (128 bit) | On demand from back-office (invalidates printed QRs) |
| Table token | `&tt=<token>` | 12-char base62 | With config token, or per table |
| Order token | returned by the server on order creation | uuid v4 | Never; order-scoped |

Endpoints under `routes/public.php`, all `auth: none`, all behind `throttle:selforder` (60/min per IP, 600/min per config) and a `ResolveSelfOrderContext` middleware:

```php
// app/Http/Middleware/ResolveSelfOrderContext.php
public function handle(Request $request, Closure $next)
{
    $config = PosConfig::where('self_token', $request->input('t'))->first();
    abort_unless($config && hash_equals($config->self_token, (string) $request->input('t')), 403);
    abort_unless($config->self_ordering_mode !== 'disabled', 404);

    $table = null;
    if ($tt = $request->input('tt')) {
        $table = $config->tables()->where('token', $tt)->first();
        abort_unless($table, 403);
        $table = $table->rootTable();          // merged tables resolve to parent
    }
    // impersonate the config's designated service account for authorization checks
    app()->instance(SelfOrderContext::class, new SelfOrderContext($config, $table));
    return $next($request);
}
```

Note the deliberate divergence from Odoo: Odoo runs self-order RPCs `with_user(self_ordering_default_user_id)` — genuine impersonation of a real user account. We do **not** impersonate. We use an explicit `SelfOrderContext` value object and dedicated, narrow endpoints. Impersonation of a full user in an anonymous public endpoint is a standing privilege-escalation hazard; a 12-endpoint hand-written surface is auditable.

Order operations additionally require the order token, compared with `hash_equals`:

```
POST   /pos-self/{config}/orders          → create/append draft   (config token [+ table token])
GET    /pos-self/orders/{uuid}            → read own order        (order token)
POST   /pos-self/orders/{uuid}/cancel     → cancel own draft      (order token)
POST   /pos-self/orders/{uuid}/pay        → start online payment  (order token)
```

**Kiosk** is different from mobile self-order: it is a fixed, staff-installed device, so it is a *registered device* (`kind: kiosk`) with a Sanctum token, plus the config token for the customer-facing routes. That gives it a stable identity for receipt printing, paper-out reporting, and terminal payments without weakening the anonymous surface.

### 2.5 Permission model

Two orthogonal axes, both required.

**Axis 1 — Back-office (users)**: Laravel policies + a role/permission table. Roles: `admin`, `manager`, `accountant`, `staff`. Enforce with `Gate::authorize()` in controllers and `can` props for the Inertia UI. Nothing exotic; `spatie/laravel-permission` is acceptable.

**Axis 2 — Register (employees)**: an ability set evaluated *client-side while offline* and *server-side on ingest*. Same string constants, one source of truth:

```php
// app/Domain/Pos/Ability.php
enum Ability: string {
    case OrderCreate            = 'order.create';
    case OrderDeleteDraft       = 'order.delete_draft';
    case OrderVoidPaid          = 'order.void_paid';          // manager
    case LineDiscount           = 'line.discount';
    case LineDiscountAbove      = 'line.discount.above_limit'; // manager
    case LinePriceOverride      = 'line.price_override';       // manager if restrict_price_control
    case RefundCreate           = 'refund.create';
    case CashDrawerOpenNoSale   = 'cash.drawer.no_sale';       // manager
    case CashInOut              = 'cash.in_out';
    case CashInOutDelete        = 'cash.in_out.delete';        // manager
    case SessionOpen            = 'session.open';
    case SessionClose           = 'session.close';
    case SessionCloseOverVariance = 'session.close.over_variance'; // manager
    case ViewMargins            = 'report.margins';
    case ReprintReceipt         = 'receipt.reprint';
    case TableTransfer          = 'table.transfer';
    case BillSplit              = 'bill.split';
}
```

Role → abilities mapping lives in `config/pos.php` and is overridable per config in the back-office (a `role_abilities` JSON column on `pos_configs`). The bootstrap payload ships the *resolved* ability list per employee, so the client never re-derives it.

Client guard:

```tsx
const can = useCan();                                   // from employee store
<Button disabled={!can('line.discount')} …/>
{can('report.margins') && <MarginBadge …/>}
```

Server guard on ingest (`OrderSyncController`): the pushed order carries `employee_id` and `approvals[]`. The server re-checks every consequential fact — a discount above the configured limit without a matching approval record is rejected with a structured error, not silently accepted. **Client-side ability checks are UX; the ingest check is the control.**

---

## 3. The offline-first data layer

This is the core of the system. Everything else is detail.

### 3.1 Vocabulary

- **Static record** — server-owned, integer `id` primary key, client never creates one. Products, taxes, pricelists, categories, partners, payment methods, floors, tables, presets. Client mutations are rare and always go through a dedicated endpoint (e.g. create customer), never through the order sync path.
- **Dynamic record** — client-creatable, **uuid** primary key. Orders, order lines, payments, pack lots, custom attribute values, courses. These are what the offline queue carries.
- **Watermark** — per-model `max(updated_at)` the client has successfully absorbed.
- **Dataset fingerprint** — a per-config hash bumped whenever a *configuration* change invalidates the client cache wholesale (payment methods changed, pricelist swapped, currency changed). Odoo's `pos.config.last_data_change` equivalent.

### 3.2 Bootstrap endpoints

Three endpoints, deliberately not one.

#### 3.2.1 Manifest

```
GET /api/v1/pos/{config}/bootstrap/manifest
Authorization: Bearer <device token>
If-None-Match: "cfg3:v41:2026-07-28T09:00:00.123Z"
```

```jsonc
// 200 OK
{
  "schema_version": 12,                    // client bundle must support >= this
  "min_client_version": "1.4.0",
  "dataset_fingerprint": "cfg3:v41",       // changes ⇒ full reload required
  "server_time": "2026-07-28T09:12:44.512345Z",   // µs precision, the new watermark ceiling
  "config": { /* the pos_config record, always sent in full, never delta'd */ },
  "session": { "id": 881, "state": "opened", "opened_at": "…", "opening_float": "150.00" },
  "models": [
    { "name": "products",        "count": 4820, "max_updated_at": "2026-07-27T18:22:01.004Z", "etag": "p:9f3c", "pages": 5 },
    { "name": "taxes",           "count": 14,   "max_updated_at": "2026-05-02T10:00:00.000Z", "etag": "t:11aa", "pages": 1 },
    { "name": "pricelist_items", "count": 902,  "max_updated_at": "2026-07-20T08:00:00.000Z", "etag": "pi:7c2", "pages": 1 },
    { "name": "partners",        "count": 100,  "max_updated_at": "2026-07-28T07:41:00.000Z", "etag": "pa:44d", "pages": 1 }
    // …
  ],
  "limits": { "product_page_size": 1000, "partner_preload": 100, "product_preload": 5000 },
  "capabilities": { "restaurant": true, "self_order": "mobile", "online_payment": true }
}
```

`ETag` on the whole manifest = `"{fingerprint}:{max over all models of updated_at}"`. A register that re-opens 5 minutes later gets a `304` and skips straight to delta sync.

**Why a manifest first?** It converts "load the POS" from an opaque 8-second wait into a progress bar with known denominators, it lets us fetch models in parallel, it makes each model independently cacheable, and it gives us a cheap liveness/version check to run every 60 s.

#### 3.2.2 Per-model fetch

```
GET /api/v1/pos/{config}/bootstrap/models/{model}?since={iso8601}&cursor={opaque}&limit=1000
```

```jsonc
{
  "model": "products",
  "records": [ /* … */ ],
  "deleted_ids": [412, 998],            // tombstones since `since`; absent on full load
  "next_cursor": "eyJpZCI6MTIwMH0",     // null when exhausted
  "server_time": "2026-07-28T09:12:44.512345Z",
  "watermark": "2026-07-27T18:22:01.004Z"   // max updated_at in THIS page set
}
```

Rules:

- **`since` absent** ⇒ full load of the model's config-scoped domain. Response is `Cache-Control: private, max-age=0, must-revalidate` with a strong `ETag`.
- **`since` present** ⇒ delta: `WHERE updated_at > :since` **OR** `id IN (SELECT record_id FROM pos_tombstones WHERE model = :m AND deleted_at > :since)`.
- Cursor pagination on `(updated_at, id)`, never `OFFSET`. Offset pagination over a table being written to skips rows.
- Every model endpoint is a `BootstrapResource` class; adding a model to the payload is adding one class and one line in a registry. No reflection, no metadata protocol.

```php
// app/Domain/Pos/Bootstrap/Contracts/BootstrapModel.php
interface BootstrapModel
{
    public function name(): string;                     // 'products'
    public function query(PosConfig $c, ?CarbonImmutable $since): Builder;
    public function transform(Collection $rows, PosConfig $c): array;   // array<array<string,mixed>>
    public function tombstoneModel(): ?string;          // 'product' or null if never deleted
    public function pageSize(): int;
}
```

```php
// app/Domain/Pos/Bootstrap/BootstrapRegistry.php
final class BootstrapRegistry
{
    /** @var array<string, class-string<BootstrapModel>> — order matters: dependencies first */
    public const MODELS = [
        'currencies', 'countries', 'taxes', 'tax_groups', 'fiscal_positions',
        'cash_roundings', 'product_categories', 'pos_categories', 'attributes',
        'attribute_values', 'products', 'product_variants', 'combos', 'combo_items',
        'pricelists', 'pricelist_items', 'payment_methods', 'presets', 'notes', 'bills',
        'printers', 'partners', 'employees', 'floors', 'tables',
        'open_orders', 'open_order_lines', 'open_order_payments', 'order_courses',
    ];
}
```

#### 3.2.3 Delta pull (steady state)

```
GET /api/v1/pos/{config}/sync/pull?since={iso8601}&models=products,partners,pricelist_items
```

Same shape as per-model fetch but multiplexed, capped at 500 records per model per call, returning `has_more: true` when the client should immediately call again. Invoked (a) on the `catalog.changed` realtime event, (b) on reconnect, (c) on a 5-minute safety timer, (d) manually from the sync popup.

#### 3.2.4 Versioning & ETag strategy summary

| Level | Mechanism | Consequence of change |
|---|---|---|
| `schema_version` | integer, bumped on breaking client-model change | Client refuses to boot, forces app update |
| `dataset_fingerprint` | per-config string | Client wipes IndexedDB and does a full reload |
| Per-model `etag` | `"{model}:{hash(max_updated_at, count)}"` | Client skips that model |
| Watermark `updated_at` | per model, µs precision | Delta pull |

**Clock discipline.** All watermarks are **server** timestamps taken from `clock_timestamp()` inside the transaction, never client clocks. `server_time` from the manifest is the ceiling for the *next* `since`; the client stores `since := response.server_time` only after the write to IndexedDB commits. Postgres `timestamptz` with microsecond precision; the `> :since` comparison is strict, which risks losing rows written in the same microsecond as the boundary. Mitigation: subtract a 1-second safety margin (`since := server_time - 1s`) and rely on idempotent upsert to absorb the overlap. Cheap, and eliminates a whole class of "one product never updates" bugs.

### 3.3 Client store — Dexie / IndexedDB schema

```ts
// packages/data/src/db.ts
import Dexie, { type Table } from 'dexie';

export class PosDb extends Dexie {
  // ── static (server-owned, keyed by id) ───────────────────────────────
  products!:        Table<ProductRow, number>;
  variants!:        Table<VariantRow, number>;
  categories!:      Table<CategoryRow, number>;
  taxes!:           Table<TaxRow, number>;
  taxGroups!:       Table<TaxGroupRow, number>;
  fiscalPositions!: Table<FiscalPositionRow, number>;
  pricelists!:      Table<PricelistRow, number>;
  pricelistItems!:  Table<PricelistItemRow, number>;
  paymentMethods!:  Table<PaymentMethodRow, number>;
  partners!:        Table<PartnerRow, number>;
  employees!:       Table<EmployeeRow, number>;
  presets!:         Table<PresetRow, number>;
  floors!:          Table<FloorRow, number>;
  tables!:          Table<TableRow, number>;
  printers!:        Table<PrinterRow, number>;
  combos!:          Table<ComboRow, number>;
  comboItems!:      Table<ComboItemRow, number>;
  attributes!:      Table<AttributeRow, number>;
  attributeValues!: Table<AttributeValueRow, number>;

  // ── dynamic (client-creatable, keyed by uuid) ────────────────────────
  orders!:    Table<OrderRow, string>;
  lines!:     Table<LineRow, string>;
  payments!:  Table<PaymentRow, string>;
  packLots!:  Table<PackLotRow, string>;
  courses!:   Table<CourseRow, string>;
  customAttrValues!: Table<CustomAttrValueRow, string>;

  // ── infrastructure ───────────────────────────────────────────────────
  outbox!:    Table<OutboxEntry, string>;     // push queue
  meta!:      Table<MetaRow, string>;         // watermarks, fingerprint, device, employee
  auditLog!:  Table<AuditEntry, string>;      // offline approvals, drawer opens, voids
  blobs!:     Table<BlobRow, string>;         // product images, logo, cached receipts

  constructor(configId: number) {
    super(`pos-${configId}`);

    this.version(1).stores({
      products:        'id, *pos_category_ids, barcode, default_code, searchText, sequence',
      variants:        'id, product_id, barcode',
      categories:      'id, parent_id, sequence',
      taxes:           'id',
      taxGroups:       'id',
      fiscalPositions: 'id',
      pricelists:      'id',
      // compound index drives the pricelist resolution scan in §4.4
      pricelistItems:  'id, pricelist_id, [pricelist_id+product_id], [pricelist_id+product_tmpl_id], [pricelist_id+category_id]',
      paymentMethods:  'id, sequence',
      partners:        'id, barcode, searchText, phoneDigits',
      employees:       'id, barcode',
      presets:         'id',
      floors:          'id, sequence',
      tables:          'id, floor_id, parent_id',
      printers:        'id',
      combos:          'id',
      comboItems:      'id, combo_id, variant_id',
      attributes:      'id',
      attributeValues: 'id, attribute_id',

      orders:   'uuid, id, state, syncState, session_id, table_id, updatedAtLocal, [state+syncState]',
      lines:    'uuid, order_uuid, variant_id, course_uuid, combo_parent_uuid',
      payments: 'uuid, order_uuid, payment_method_id',
      packLots: 'uuid, line_uuid',
      courses:  'uuid, order_uuid, index',
      customAttrValues: 'uuid, line_uuid',

      outbox:   'id, ++seq, kind, state, nextAttemptAt, [state+nextAttemptAt]',
      meta:     'key',
      auditLog: 'id, ++seq, syncedAt',
      blobs:    'key',
    });
  }
}
```

Design notes, each load-bearing:

- **DB name is per config** (`pos-3`), so a shared back-of-house tablet that operates two registers keeps two clean datasets and "reset this register" is `Dexie.delete('pos-3')`.
- **`searchText`** is precomputed at ingest: `normalize(name + ' ' + default_code + ' ' + barcode + ' ' + variantAttrs)` with diacritics folded and lowercased. Searching 5 000 products by substring over a precomputed field in memory is ~1 ms; doing it over raw fields with `toLocaleLowerCase()` per keystroke is not.
- **`phoneDigits`** likewise — customers are found by typing digits, and `+32 475 …` must match `475`.
- **Compound indexes on `pricelistItems`** exist because pricelist resolution is the hottest non-tax computation (§4.4) and we want it index-driven rather than a full scan.
- **`blobs`** holds images as `Blob` (IndexedDB stores Blobs natively; base64 in a string costs 33 % more and forces a decode on every render). Product images are fetched lazily and opportunistically, never as part of bootstrap. The company logo and receipt assets are fetched eagerly because receipts must print offline.
- **`[state+syncState]` compound index on orders** drives the two hottest queries: "draft orders for the ticket list" and "unsynced paid orders" (the data-loss guard).
- **No `_meta` columns smeared across tables** — sync bookkeeping lives on `meta` and `outbox`.

#### Hydration

```
boot()
 ├─ open Dexie                                            (~5 ms)
 ├─ read meta: {fingerprint, watermarks, device, employee} (~2 ms)
 ├─ load catalog into memory indexes                       (~120 ms for 5k products)
 │    products, variants, categories, taxes, pricelists, fiscal positions, payment methods
 ├─ load dynamic records into the order store              (~10 ms)
 │    orders where state != 'done' OR syncState != 'synced'
 ├─ mount React, render register (INTERACTIVE)             ← target: < 1.2 s from cold on a 2019 tablet
 └─ background:
      ├─ manifest fetch → delta pull → merge
      ├─ outbox drain
      ├─ Reverb connect
      └─ image warmup
```

The register is **interactive before the network is consulted**. That is a hard requirement, not an optimisation: if the first paint depends on a fetch, the offline story is a lie.

Catalog loading uses `bulkGet`/`toArray` per table inside one `db.transaction('r', …)`. 5 000 product rows ≈ 3–4 MB deserialized; measured Dexie throughput is comfortably within budget. If a tenant exceeds ~20 000 products we move catalog hydration into a **worker** that posts back a transferable structured clone — the interface for that (`CatalogSource`) is designed in from day one so it can be swapped without touching call sites.

### 3.4 The in-memory model layer

#### 3.4.1 What we are replacing

Odoo's `PosStore` + `related_models` gives: class instances per record, relation traversal (`line.order_id.partner_id.name`), lazy computed getters with cache invalidation, dirty tracking, and ORM-command serialization. We need all of it. We do **not** need runtime schema discovery.

#### 3.4.2 Recommended state management: **split stores — frozen catalog + Zustand/Immer order store**

**Recommendation:**

| Data | Where it lives | Why |
|---|---|---|
| Catalog (products, taxes, pricelists, partners, config, …) | A frozen `CatalogIndex` module singleton, exposed by context, subscribed via `useSyncExternalStore` | Read-mostly, large, changes only on delta sync. Putting it in Immer would cost a structural-sharing pass over megabytes on every keystroke. |
| Orders / lines / payments (the mutable working set) | **Zustand + Immer middleware**, normalized by uuid | Small (tens of records), mutated constantly, needs ergonomic nested updates and fine-grained subscriptions. |
| Transient UI (numpad buffer, selected line, dialogs, screen) | Zustand slices, no persistence | Ephemeral. |

**Why Zustand and not the alternatives:**

- **vs. Redux Toolkit** — RTK is a fine choice and its devtools/entity-adapter story is better. It loses on ceremony: every one of the ~120 register mutations becomes a reducer + action + selector. Zustand's store actions are plain methods on the store, which maps 1:1 onto Odoo's `PosStore` methods and makes the port reviewable side by side.
- **vs. Jotai/Recoil (atom graph)** — atoms are excellent for derived-value graphs, but our derived values are *whole-order recomputations* (tax totals), not fine-grained cells. An atom per line per field is enormous ceremony for no gain, and cross-atom transactional updates ("apply pricelist to all lines") are awkward.
- **vs. TanStack Query** — it is a server-cache library. Our server cache is IndexedDB and our mutations are offline-first with a bespoke queue. TanStack Query is used in the **back-office** app, where it belongs, and not in the register.
- **vs. MobX** — closest in spirit to Odoo's reactivity and genuinely good here. Rejected on team-cost grounds: proxy-based observability makes "why did this re-render" and "why is this value stale" harder for a team that will be mostly writing PHP. Zustand's explicit selectors keep the data flow legible.
- **vs. a custom reactive store** — we do write a custom layer, but on *top* of Zustand (the relation/derived layer below), not instead of it. Rewriting subscription plumbing is undifferentiated work.

**Immer is applied only to the order store**, and even there with `enableMapSet()` off — we normalize with plain objects keyed by uuid, because Immer's Map support is slower and `structuredClone` interop is cleaner with plain objects.

#### 3.4.3 The domain model in TypeScript

Records are **plain data**; behaviour lives in pure functions and in a thin entity facade. This is a deliberate departure from Odoo's class-instance model: plain data is structured-cloneable (worker + IndexedDB + BroadcastChannel for the customer display all need this), Immer-friendly, and trivially serializable.

```ts
// packages/domain/src/models/order.ts
export type Uuid = string & { readonly __brand: 'uuid' };

export type SyncState = 'local' | 'queued' | 'syncing' | 'synced' | 'error';

export interface Order {
  uuid: Uuid;
  id: number | null;                 // server id, null until first successful sync
  session_id: number;
  config_id: number;
  device_id: string;
  employee_id: number | null;
  partner_id: number | null;
  pricelist_id: number | null;
  fiscal_position_id: number | null;
  preset_id: number | null;
  preset_time: string | null;
  table_id: number | null;
  guest_count: number | null;

  state: 'draft' | 'paid' | 'done' | 'cancelled';
  is_refund: boolean;
  refunded_order_uuid: Uuid | null;

  reference: string;                 // client-generated, device-namespaced (§6)
  tracking_number: string;
  receipt_token: string;             // 5-char portal code
  access_token: Uuid;

  to_invoice: boolean;
  shipping_date: string | null;
  general_customer_note: string | null;
  internal_note: string | null;
  print_count: number;

  /** Snapshot of what the kitchen has already been told. */
  last_prep_snapshot: PrepSnapshot | null;

  created_at: string;                // ISO, client clock — display only
  ordered_at: string | null;         // set at payment validation
  updatedAtLocal: number;            // Date.now(), drives IDB flush ordering

  // ── sync bookkeeping (never sent to the server) ───────────────────
  syncState: SyncState;
  syncError: SyncError | null;
  rev: number;                       // bumped on every mutation → memo key
  baseline: OrderBaseline | null;    // last server-acknowledged shape (for create→update rewrite)
}

export interface OrderLine {
  uuid: Uuid;
  id: number | null;
  order_uuid: Uuid;
  variant_id: number;
  product_id: number;
  full_name: string;
  qty: number;
  price_unit: number;                // pre-discount, pre-tax-or-incl per iface_tax_included
  price_extra: number;               // from no_variant attributes
  price_type: 'original' | 'manual' | 'automatic';
  discount: number;                  // percent 0..100
  tax_ids: number[];                 // BEFORE fiscal position
  attribute_value_ids: number[];
  custom_attr_value_uuids: Uuid[];
  pack_lot_uuids: Uuid[];
  note: string | null;               // internal / kitchen
  customer_note: string | null;
  combo_parent_uuid: Uuid | null;
  combo_item_id: number | null;
  course_uuid: Uuid | null;
  refunded_line_uuid: Uuid | null;
  refunded_line_id: number | null;
  rev: number;
}
```

Money is represented as `number` in **minor-unit-scaled decimal** — i.e. plain JS numbers holding e.g. `12.34` — and every arithmetic result passes through an explicit rounding step from the tax engine. We do **not** use a bignum library on the client. Justification: the tax engine already rounds at every specified point (§4.5), IEEE-754 doubles are exact for all integers below 2⁵³ and the accumulated error before rounding is ≤ 2⁻⁴⁰ for realistic basket sizes, and a bignum type breaks structured cloning and destroys the parity-testing story with PHP floats. The **server** uses `brick/math` `BigDecimal` for the ledger-facing computation (§4.2) — divergence between the two is exactly what the parity fixtures exist to catch, and in practice the rounding discipline makes them agree bit-for-bit.

#### 3.4.4 Normalized store + relations

```ts
// packages/data/src/stores/orderStore.ts
interface OrderSlice {
  orders:   Record<Uuid, Order>;
  lines:    Record<Uuid, OrderLine>;
  payments: Record<Uuid, Payment>;
  courses:  Record<Uuid, Course>;
  packLots: Record<Uuid, PackLot>;

  // relation indexes, maintained on write — never derived by scanning
  linesByOrder:    Record<Uuid, Uuid[]>;
  paymentsByOrder: Record<Uuid, Uuid[]>;
  childLines:      Record<Uuid, Uuid[]>;   // combo parent → children
  linesByCourse:   Record<Uuid, Uuid[]>;

  selectedOrderUuid: Uuid | null;
  selectedLineUuid:  Uuid | null;
}

export const useOrderStore = create<OrderSlice & OrderActions>()(
  subscribeWithSelector(
    immer((set, get) => ({
      /* … state … */

      addLine(orderUuid, draft) {
        const uuid = newUuid();
        set(s => {
          s.lines[uuid] = materializeLine(uuid, orderUuid, draft);
          (s.linesByOrder[orderUuid] ??= []).push(uuid);
          if (draft.combo_parent_uuid) (s.childLines[draft.combo_parent_uuid] ??= []).push(uuid);
          bumpRev(s, orderUuid);
        });
        markDirty(orderUuid);
        return uuid;
      },

      setQuantity(lineUuid, qty) {
        set(s => {
          const line = s.lines[lineUuid];
          const rounded = roundQty(qty, uomOf(line));
          if (rounded === line.qty) return;
          line.qty = rounded;
          line.rev++;
          propagateComboRatio(s, line);          // combo children follow the parent
          bumpRev(s, line.order_uuid);
        });
        markDirty(lineUuidToOrder(lineUuid));
      },
      /* … ~120 more … */
    })),
  ),
);
```

`bumpRev` increments `order.rev` and stamps `updatedAtLocal`. **`rev` is the whole derived-value strategy**: it is the memo key.

#### 3.4.5 Derived / computed values

Odoo caches order prices in `order._prices` with a manual dirty flag. We do the same thing, but as a pure function memoized on `(order.rev, catalog.version)`:

```ts
// packages/domain/src/pricing/orderTotals.ts
export interface OrderTotals {
  subtotal: number;                        // tax-excluded
  taxTotal: number;
  total: number;                           // tax-included, before cash rounding
  roundedTotal: number;                    // after cash rounding
  cashRounding: number;
  taxByGroup: Array<{ groupId: number; label: string; base: number; amount: number }>;
  perLine: Record<Uuid, LineTotals>;
  totalDiscount: number;
  amountPaid: number;
  amountDue: number;
  change: number;
}

export function computeOrderTotals(input: OrderTotalsInput): OrderTotals { /* pure, §4 */ }
```

Wired into React with a two-level cache:

```ts
// packages/data/src/hooks/useOrderTotals.ts
const cache = new WeakMap<Order, { rev: number; catalogVersion: number; value: OrderTotals }>();

export function useOrderTotals(orderUuid: Uuid): OrderTotals {
  const order   = useOrderStore(s => s.orders[orderUuid]);
  const lines   = useOrderStore(s => s.linesByOrder[orderUuid], shallow);
  const catalog = useCatalog();

  return useMemo(
    () => computeOrderTotals(buildInput(order, lines, catalog)),
    [order.rev, catalog.version, orderUuid],       // ← rev, not the object graph
  );
}
```

The `rev`-keyed memo means a 40-line order recomputes taxes exactly once per mutation, not once per subscribed component. Measured budget: **< 3 ms for a 50-line order with 3 tax groups and compound taxes**. Enforced by a Vitest benchmark that fails CI on regression.

Line-level derived values (display price, strike-through original price, discount amount, tax labels) are selected out of the single `OrderTotals.perLine` map rather than computed per component — this is the single biggest performance lever in the whole client and Odoo gets it right, so we copy it.

#### 3.4.6 Dirty tracking & baselines

```ts
export interface OrderBaseline {
  serverRev: string;              // opaque, echoed by the server on every ack
  order: Partial<Order>;          // acknowledged field values
  lines: Record<Uuid, Partial<OrderLine>>;
  payments: Record<Uuid, Partial<Payment>>;
  deletedLineUuids: Uuid[];       // acknowledged deletions
}
```

`markDirty(uuid)` does three things: sets `syncState = 'local'`, stamps `updatedAtLocal`, and schedules a **debounced IndexedDB flush (250 ms)**. Two overrides on the debounce, both learned from Odoo's incident history:

1. **Immediate flush** on payment validation, before navigating to the receipt — a crash between "paid" and "flushed" loses money.
2. **Immediate flush** on `visibilitychange → hidden` and on `pagehide`.

The diff against `baseline` is what produces the push payload (§3.6), and it is what makes **create→update rewriting** work.

### 3.5 Delta / incremental pull sync

```ts
// packages/data/src/sync/pull.ts
export async function pullDeltas(models?: string[]): Promise<PullResult> {
  const since = await meta.get('watermark.global');
  const res = await api.get('/sync/pull', { since, models: models?.join(',') });

  await db.transaction('rw', affectedTables(res), async () => {
    for (const [model, payload] of Object.entries(res.models)) {
      const table = tableFor(model);
      if (payload.records.length) await table.bulkPut(payload.records.map(prepare(model)));
      if (payload.deleted_ids.length) await table.bulkDelete(payload.deleted_ids);
      await meta.put({ key: `watermark.${model}`, value: payload.watermark });
    }
    await meta.put({ key: 'watermark.global', value: shiftBack(res.server_time, 1_000) });
  });

  catalog.applyDeltas(res);          // rebuild affected in-memory indexes, bump catalog.version
  return { hasMore: res.has_more };
}
```

**Tombstones.** Hard deletes are invisible to a watermark, so every soft-deletable static model writes to a tombstone table:

```php
Schema::create('pos_tombstones', function (Blueprint $t) {
    $t->id();
    $t->string('model', 40)->index();
    $t->unsignedBigInteger('record_id');
    $t->foreignId('pos_config_id')->nullable()->index();   // null = all configs
    $t->timestampTz('deleted_at')->index();
    $t->index(['model', 'deleted_at']);
});
```

Written by a `RecordsTombstones` model trait on `deleted` and on `archived` (soft-archive counts as a delete for the client — an archived product must vanish from the register). Pruned by a nightly job at `deleted_at < now() - 30 days`; a device offline longer than 30 days is forced into a full reload via `dataset_fingerprint`.

**Relevance changes.** A product that stays alive but leaves the config's domain (category restriction changed, `available_in_pos` unset) is *not* a delete but must still be purged locally — Odoo's `filter_local_data`. We handle it with the same tombstone table plus a `reason: 'irrelevant'` column, emitted by the config-change observer. Simpler than a second protocol.

**Ordering.** Deltas are applied inside a single Dexie transaction in `BootstrapRegistry::MODELS` order, so referential integrity holds at every commit point. If a referenced record is genuinely missing (a line references a product not in our slice), the client issues a targeted `GET /api/v1/pos/{config}/records?model=products&ids=…` backfill — the equivalent of Odoo's `missingRecursive`.

### 3.6 Push sync

#### 3.6.1 Endpoint

```
POST /api/v1/pos/{config}/orders/sync
Authorization: Bearer <device token>
Idempotency-Key: <uuid, one per attempt-group>
Content-Type: application/json
```

```jsonc
{
  "device_id": "0f8b…",
  "employee_id": 17,
  "client_version": "1.4.2",
  "client_time": "2026-07-28T09:31:02.144Z",
  "orders": [
    {
      "uuid": "9f2c…",
      "op": "upsert",                       // upsert | cancel | delete_draft
      "base_rev": "r7",                     // last acked server rev, null on create
      "order": {
        "session_id": 881,
        "state": "paid",
        "partner_id": 42,
        "pricelist_id": 3,
        "fiscal_position_id": null,
        "preset_id": 1,
        "table_id": 12,
        "guest_count": 4,
        "reference": "26D3-3-000412",
        "tracking_number": "412",
        "receipt_token": "K7F2Q",
        "access_token": "b9c1…",
        "to_invoice": false,
        "ordered_at": "2026-07-28T09:30:58.001Z",
        "amount_total_client": "48.30",     // proposal only — server recomputes
        "amount_tax_client": "8.38"
      },
      "lines":    [ { "op": "create", "uuid": "aa…", "variant_id": 901, "qty": 2, "price_unit": "12.50",
                      "discount": 0, "tax_ids": [1], "attribute_value_ids": [], "note": null,
                      "combo_parent_uuid": null, "course_uuid": "c1…" },
                    { "op": "update", "uuid": "bb…", "qty": 1 },
                    { "op": "delete", "uuid": "cc…" } ],
      "payments": [ { "op": "create", "uuid": "pp…", "payment_method_id": 2, "amount": "48.30",
                      "is_change": false, "paid_at": "2026-07-28T09:31:00.000Z",
                      "terminal": { "card_brand": "visa", "card_last4": "4242", "auth_code": "…" } } ],
      "courses":  [ { "op": "create", "uuid": "c1…", "index": 1, "fired": true } ],
      "approvals":[ { "uuid": "ap…", "ability": "line.discount.above_limit", "manager_employee_id": 3,
                      "verified": "offline", "at": "2026-07-28T09:29:11.000Z", "context": { "line_uuid": "aa…" } } ]
    }
  ]
}
```

Design notes:

- **ORM-command-style ops.** Odoo's `[0,0,vals] / [1,id,vals] / [2,id]` triple, rewritten as `{op, uuid, …}`. Keeping the *command* shape (rather than sending the whole order every time) is what makes appending a line to a 60-line restaurant tab a 400-byte push instead of 40 kB — over a flaky 3G link that is the difference between working and not.
- **`base_rev`** enables optimistic concurrency for the shared-order case (two waiters on one table). See conflict rules below.
- **Monetary values are strings.** JSON numbers go through a double on both ends; `"48.30"` does not. The server casts to `BigDecimal`.
- **Client amounts are labelled `_client`.** They exist for reconciliation/alerting, never for posting.
- **One request may carry many orders**, but the server processes each independently and returns per-order results. A poisoned order must not block the queue behind it.

#### 3.6.2 Response

```jsonc
// 200 OK — always 200 if the request was well-formed; per-order status inside
{
  "server_time": "2026-07-28T09:31:02.913Z",
  "results": [
    {
      "uuid": "9f2c…",
      "status": "ok",                       // ok | conflict | rejected | superseded
      "server_rev": "r8",
      "order": {
        "id": 55123,
        "name": "Bar/00412",                // server-assigned display name
        "sequence_number": 412,
        "state": "paid",
        "amount_total": "48.30",
        "amount_tax": "8.38",
        "amount_paid": "48.30",
        "amount_change": "0.00",
        "invoice_id": null,
        "updated_at": "2026-07-28T09:31:02.900Z"
      },
      "lines":    [ { "uuid": "aa…", "id": 90211, "price_subtotal": "25.00", "price_subtotal_incl": "30.25" } ],
      "payments": [ { "uuid": "pp…", "id": 4410 } ],
      "warnings": [ { "code": "amount_mismatch", "client": "48.30", "server": "48.31", "delta": "0.01" } ]
    }
  ]
}
```

Statuses:

| Status | Meaning | Client action |
|---|---|---|
| `ok` | Persisted; ids and authoritative amounts returned | Merge ids, set `syncState = 'synced'`, store new baseline + `server_rev` |
| `conflict` | `base_rev` stale (another device changed the order) | Server returns its current order state; client runs the merge rules below |
| `rejected` | Permanently invalid (unknown product, closed session with no fallback, ability violation, revoked device) | Move to a **quarantine** state, surface to cashier, never retry blindly |
| `superseded` | The order is already `paid`/`done` server-side and the push was a stale draft | Discard the local mutation, adopt server state |

#### 3.6.3 Idempotency & the create→update rewrite

Three layers, all necessary:

1. **`Idempotency-Key` header** (per HTTP attempt-group) → `idempotency_keys` table with the response body, TTL 24 h. Protects against "request succeeded, response lost, client retries" — the classic offline killer. Returns the recorded response verbatim.
2. **UUID uniqueness** at the database level on `pos_orders.uuid`, `pos_order_lines.uuid`, `pos_payments.uuid` (unique indexes). Protects against a retry with a *different* idempotency key.
3. **Create→update rewriting**, server side:

```php
// app/Domain/Pos/Sync/OrderIngestService.php
private function applyLineCommands(PosOrder $order, array $commands): void
{
    $existing = $order->lines()->pluck('id', 'uuid');           // uuid => id

    foreach ($commands as $cmd) {
        $uuid = $cmd['uuid'];
        $op = $cmd['op'];

        // ── the rewrite: a CREATE for a uuid we already have is an UPDATE ──
        if ($op === 'create' && $existing->has($uuid)) {
            $op = 'update';
        }
        // ── and an UPDATE for a uuid we've never seen is a CREATE ──
        if ($op === 'update' && ! $existing->has($uuid)) {
            $op = 'create';
        }

        match ($op) {
            'create' => $this->createLine($order, $cmd),
            'update' => $this->updateLine($order, $existing[$uuid], $cmd),
            'delete' => $this->deleteLine($order, $existing[$uuid] ?? null),
        };
    }
}
```

Both directions matter. `create`→`update` handles the retry case (Odoo does exactly this). `update`→`create` handles the *reordering* case: an offline device pushed line A's create, the request was lost, then the cashier edited the line, and the outbox coalesced the two into a single `update`. Without the reverse rewrite that line silently disappears.

The same rewrite applies to payments and courses.

#### 3.6.4 The outbox: retry, backoff, coalescing

```ts
// packages/data/src/sync/outbox.ts
export interface OutboxEntry {
  id: Uuid;
  seq: number;                       // monotonic — preserves causal order
  kind: 'order.sync' | 'session.cash_move' | 'session.open' | 'session.close'
      | 'partner.create' | 'audit.batch' | 'order.cancel' | 'prep.sent';
  payload: unknown;
  targetUuid: Uuid | null;           // for coalescing
  state: 'pending' | 'inflight' | 'error' | 'quarantined';
  attempts: number;
  nextAttemptAt: number;             // epoch ms
  lastError: SyncError | null;
  createdAt: number;
}
```

**`audit.batch`** carries facts the till observed that the server has no other way to learn — the drawer opening is the one that matters, since it is an ESC/POS pulse sent straight from the browser to the printer (BAN-413). Two rules, both load-bearing:

- **Idempotency is per event, not per batch.** Each event carries its own uuid, which becomes the `audit_logs` row's; the unique index is the real guard. A redelivered batch must not become two openings, and a batch that grew between attempts must not lose its new events.
- **The event name is whitelisted server-side.** A device bearer token lives on the till, which is a machine the trail is partly evidence *about*. A passthrough would let anyone holding a paired device forge a `session.closed` into the record — with a real device id and a real employee attached, which is worse than no row at all. `OrderSyncService::ClientAuditEvents` is the accepted set.

**Coalescing.** When an order mutates while an entry for it is already `pending`, we do not append a second entry — we replace the payload with a fresh diff-from-baseline. This keeps the queue bounded during a long offline stretch. An entry in `inflight` is never touched; the new mutation creates a follow-up entry that is sent after the in-flight one resolves. Per-order serialization is guaranteed by an in-memory `Map<Uuid, Promise>` lock.

**Ordering.** Entries drain strictly by `seq` **within a `targetUuid`**, and with bounded parallelism (4) across different targets. Cross-order ordering does not matter except for session lifecycle entries, which are marked `barrier: true` and drain alone.

**Backoff** — exponential with full jitter, capped:

```ts
const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
```

Attempts 1–3 within 5 s (a transient blip should be invisible); then 1 s, 2 s, 4 s, …, capped at 30 s. There is **no maximum attempt count for network errors** — a register offline for six hours must still be trying at hour six. There *is* a cap for `rejected` (zero retries) and for `5xx` (after 20 attempts the entry moves to `error` and raises a persistent banner, but continues retrying at 60 s).

**Triggers to drain**: `online` event, Reverb reconnect, successful `/ping`, app foreground, every 15 s while `pending` entries exist, and immediately on enqueue.

**Background Sync.** Where supported (Chromium), the outbox also registers `sync` / `periodicsync` tags so a closed tab still flushes (§8.5). Treated strictly as a bonus; correctness never depends on it.

#### 3.6.5 Conflict rules

Conflicts are rare but not theoretical: shared tables, trusted configs, and self-order all write the same order.

| Situation | Rule |
|---|---|
| Server order is `draft`, client `base_rev` matches | Apply commands. |
| Server order is `draft`, `base_rev` stale | **Line-level merge.** Server replays the client's commands on top of its current state; `create` always wins (an added line is never lost); `update` applies only to fields the client actually changed (that is why we diff against baseline rather than sending full records); `delete` applies only if the line's server `updated_at` ≤ client baseline (otherwise it is skipped and reported as a warning — deleting a line someone else just edited is refused). |
| Server order is `paid`/`done`, client pushes draft changes | `superseded`. Client discards its mutation and adopts server state. Loud toast: "Order 412 was already paid on another device." |
| Server order is `cancelled` | `superseded`. Client marks its copy cancelled. |
| Client pushes `paid`, server already `paid` with a *different* payment set | `conflict` with `reason: 'double_payment'`. Never auto-merge money. The order is quarantined and a manager resolution screen shows both payment sets. |
| Two devices claim the same table simultaneously | The **oldest server-side draft order for that table wins**; the loser's lines are merged into the winner (Odoo does the same in `devices_synchronisation.js`) and the loser is deleted. This happens server-side on ingest, atomically under `SELECT … FOR UPDATE` on the table row. |
| Same `reference` from two devices | Impossible by construction (§6). If it happens (device_seq reuse), the server appends `-D{device_seq}` and warns. |

**Closed-session handling** (Odoo's `_get_valid_session` / rescue sessions):

```php
private function resolveSession(PosConfig $config, int $requestedSessionId, string $orderUuid): PosSession
{
    $session = PosSession::find($requestedSessionId);

    if ($session && $session->config_id === $config->id && $session->state === 'opened') {
        return $session;
    }
    // Prefer any currently-open session on the same config.
    if ($open = $config->openSession()) {
        Log::info('pos.sync.session_rerouted', ['order' => $orderUuid, 'from' => $requestedSessionId, 'to' => $open->id]);
        return $open;
    }
    // Otherwise create a rescue session so the money is never dropped on the floor.
    return PosSession::createRescue($config, reason: "late order {$orderUuid}");
}
```

A rescue session is `is_rescue = true`, excluded from the "one open session per config" constraint, invisible in the register's session picker, and surfaced in back-office with a red badge requiring a manager to reconcile and close it. **We never reject an order because its session closed.** Losing a real sale to a bookkeeping constraint is the worst possible failure mode.

#### 3.6.6 Error surfacing to the cashier

Errors are classified, not raw:

```ts
export type SyncError =
  | { kind: 'offline' }                                            // silent — banner only
  | { kind: 'server_unreachable'; status?: number }                // silent for 60s, then banner
  | { kind: 'auth'; detail: 'revoked' | 'expired' }                // blocking modal
  | { kind: 'version'; min: string }                               // blocking modal: "update required"
  | { kind: 'validation'; field: string; message: string }         // per-order chip in ticket list
  | { kind: 'conflict'; reason: string; serverState: unknown }     // resolution dialog
  | { kind: 'rejected'; code: string; message: string }            // quarantine + manager dialog
  | { kind: 'unknown'; message: string };
```

UI treatment, in order of intrusiveness:

1. **Sync indicator in the navbar** — always visible: green (all synced), amber with a count (`3 pending`), red (`1 failed`). Tapping opens the sync panel listing every outbox entry with its order reference, age, attempt count, and last error, plus **Retry now** and **Retry all**.
2. **Never block the sale.** A failed sync of order 411 must not prevent ringing up order 412. This is the single most important UX rule in the offline design.
3. **Quarantine dialog** for `rejected`/`conflict` — shown once, dismissible, re-openable from the sync panel. Offers: retry, edit-and-retry (for validation errors like a missing customer on an invoiced order), or "export & discard" (writes the order JSON to a downloadable file and to the audit log before removing it) behind a manager approval.
4. **Blocking modal** only for `auth` and `version` — the device genuinely cannot function.
5. **Close-session gate.** `session.close` refuses while any order is `pending`/`error`, and the closing screen shows exactly which ones with a **Force close** path behind manager approval that pushes the offending orders into the rescue-session flow.

### 3.7 Server-authoritative vs client-computed

The single most important table in this document.

| Concern | Authority | Notes |
|---|---|---|
| Line subtotal / tax split | **Client computes for display; server recomputes and its value is stored.** | Both run the same spec (§4). Divergence > 0 emits an `amount_mismatch` warning to logs + a Sentry event. Divergence > `currency.rounding` fails the sync with `rejected`. |
| Order total, tax total, cash rounding | **Server** | Client value is a proposal, echoed back for reconciliation. |
| `amount_paid`, change | **Server** | Recomputed from payment rows; Odoo's "we don't trust the client" rule, kept verbatim. |
| Payment *capture* (terminal, online) | **Server** | The client may report a terminal result but the accounting payment exists only when the server says so. |
| Order display name (`Bar/00412`) | **Server** | Assigned at first successful sync. |
| Order **reference** + tracking number | **Client** | Must exist offline for the receipt. Collision-free by device namespacing (§6). Server accepts and stores; only intervenes on a genuine collision. |
| `sequence_number` (per session) | **Server** | Gapless per session; assigned at ingest. |
| Invoice number | **Server** | Legally sequential, never client-side. |
| Session open/close, opening float, closing variance | **Server** | Client queues the intent; the state transition is the server's. |
| Stock quantity / availability | **Server** | The client shows a *cached, advisory* quantity clearly labelled as of a timestamp. Never blocks a sale on client stock. |
| Lot/serial availability | **Server** (advisory client cache) | Confirmation-with-warning path when offline, exactly as Odoo does. |
| Pricelist resolution | **Client** (server re-verifies) | Must work offline. Server recomputes on ingest for self-order (untrusted client) and *verifies* for register (trusted-ish client) — a mismatch is a warning, not a rejection, because a manual price override is legitimate (`price_type: 'manual'`). |
| Fiscal position mapping | **Client** computes, **server** authoritative | Same treatment as taxes. |
| Discounts | **Client**, gated by abilities; **server** re-checks limits | A discount above the config limit without an approval record is `rejected`. |
| Refund linkage & caps | **Server** | Client proposes `refunded_line_uuid`; server enforces "cannot refund more than remaining refundable qty" under a row lock. This is a money-loss vector and cannot be client-enforced. |
| Loyalty / promotions (future) | **Server** | Deliberately out of the offline path in v1. |
| Receipt content | **Client** | Rendered locally; the server can re-render for email/portal. |
| Kitchen "already sent" snapshot | **Client** proposes, **server** arbitrates by `sent_at` | Prevents duplicate tickets across devices (Odoo's `metadata.serverDate` guard). |

Rule of thumb we apply consistently: **anything that can be recomputed from primary facts is recomputed server-side; anything the cashier must see before the network answers is computed client-side.** The two are then compared, and the comparison is monitored.

---

## 4. Pricing & tax engine

### 4.1 The problem

Two implementations of the same arithmetic — PHP for the ledger, TypeScript for the till — that must agree to the cent, forever, across price-included taxes, compound taxes, fiscal-position remapping, six pricelist rule types, three rounding modes, cash rounding, and negative (refund) documents. Odoo solves this by literally porting `account_tax.py` to `account_tax.js` and hoping. We do better with a written spec plus an executable parity corpus.

### 4.2 Structure

```
resources/tax-spec/
  SPEC.md                    # normative prose: the algorithm, step by step, numbered
  fixtures/
    001-simple-excluded.json
    002-simple-included.json
    003-compound-included.json
    004-affected-base.json
    005-fixed-amount.json
    006-division-tax.json          (tax on gross / "amount_type: division")
    007-negative-factor.json
    008-fiscal-position-remap.json
    009-fiscal-position-to-none.json
    010-pricelist-fixed.json
    …
    040-cash-rounding-half-up.json
    041-cash-rounding-up-nearest-05.json
    050-refund-sign.json
    060-multiline-rounding-globally.json
    061-multiline-rounding-per-line.json
    …
```

Implementations:

```
app/Domain/Pricing/TaxEngine.php               ← uses brick/math BigDecimal internally
resources/js/packages/domain/src/pricing/taxEngine.ts   ← uses number + explicit rounding
```

Neither implementation may contain a magic number that is not traceable to a numbered step in `SPEC.md`. Code review rule.

### 4.3 The parity corpus

One fixture file = one scenario, in a language-neutral schema:

```jsonc
// resources/tax-spec/fixtures/003-compound-included.json
{
  "name": "Compound tax with price-included base, single line",
  "spec_refs": ["4.5.2", "4.5.4"],
  "currency": { "code": "EUR", "rounding": "0.01", "decimal_places": 2 },
  "rounding_method": "round_per_line",          // round_per_line | round_globally
  "taxes": [
    { "id": 1, "name": "VAT 21%", "amount_type": "percent", "amount": 21,
      "price_include": true, "include_base_amount": true, "sequence": 1,
      "is_base_affected": false, "tax_group_id": 1 },
    { "id": 2, "name": "Eco 2%", "amount_type": "percent", "amount": 2,
      "price_include": true, "include_base_amount": false, "sequence": 2,
      "is_base_affected": true, "tax_group_id": 2 }
  ],
  "lines": [
    { "id": "L1", "quantity": 3, "price_unit": "12.10", "discount": 10, "tax_ids": [1, 2], "sign": 1 }
  ],
  "cash_rounding": null,
  "expected": {
    "lines": [
      { "id": "L1", "base": "26.30", "total_excluded": "26.30", "total_included": "32.67",
        "taxes": [ { "tax_id": 1, "base": "26.30", "amount": "5.85" },
                   { "tax_id": 2, "base": "26.83", "amount": "0.52" } ] }
    ],
    "totals": { "subtotal": "26.30", "tax_total": "6.37", "total": "32.67",
                "by_group": [ { "group_id": 1, "base": "26.30", "amount": "5.85" },
                              { "group_id": 2, "base": "26.83", "amount": "0.52" } ] }
  }
}
```

All monetary values are **strings**. This is what makes the corpus language-neutral: PHP parses to `BigDecimal`, TS parses to `number` and compares after formatting back to a fixed-precision string. No float equality anywhere.

**Both test suites read the same directory.**

```php
// tests/Unit/Pricing/TaxParityTest.php
use Illuminate\Support\Facades\File;

dataset('tax_fixtures', fn () => collect(File::files(base_path('resources/tax-spec/fixtures')))
    ->map(fn ($f) => [basename($f), json_decode(File::get($f), true, flags: JSON_THROW_ON_ERROR)])
    ->all());

it('matches the tax spec', function (string $name, array $fx) {
    $result = app(TaxEngine::class)->compute(TaxInput::fromFixture($fx));
    expect($result->toFixtureShape())->toEqual($fx['expected']);
})->with('tax_fixtures');
```

```ts
// packages/domain/src/pricing/__tests__/taxParity.test.ts
import { describe, it, expect } from 'vitest';
const fixtures = import.meta.glob('/resources/tax-spec/fixtures/*.json', { eager: true });

describe('tax spec parity', () => {
  for (const [path, mod] of Object.entries(fixtures)) {
    const fx = (mod as any).default;
    it(`${path}: ${fx.name}`, () => {
      expect(toFixtureShape(computeTaxes(fromFixture(fx)))).toEqual(fx.expected);
    });
  }
});
```

**Governance:**

- A tax-engine change without a new or modified fixture is rejected in review. No exceptions.
- Every production `amount_mismatch` warning (§3.7) is triaged into a new fixture. The corpus grows from real divergences.
- A **generative** pass runs nightly (not in PR CI): 10 000 randomised scenarios (random tax stacks, quantities with 3-decimal precision, discounts, refund signs, both rounding methods) executed by both engines via a thin CLI harness; any divergence is dumped as a new fixture file and opens a ticket. `fast-check` on the TS side generates; a `php artisan tax:verify-corpus` command consumes.
- Fixtures are also **imported from Odoo** as a one-off migration exercise: run the legacy system over the corpus scenarios and record its outputs. Where we deliberately differ from Odoo, the fixture carries `"deviates_from_odoo": "reason"`.

### 4.4 Pricelist resolution

Normative order, evaluated per line, first match wins within each tier:

1. Determine the applicable pricelist: `order.pricelist_id` ?? `preset.pricelist_id` ?? `partner.pricelist_id` (only if `use_pricelist`) ?? `config.pricelist_id`.
2. Collect candidate items from that pricelist where `date_start <= now <= date_end` (nulls = open) and `min_quantity <= qty`.
3. Rank candidates by **specificity**, then by `min_quantity` descending:
   1. `variant_id` match
   2. `product_id` (template) match
   3. `category_id` match — walking the category tree from the product's category **upward**, nearest ancestor first
   4. global (no product/category constraint)
4. Apply the winning item's `compute_price`:
   - `fixed` → `fixed_price`
   - `percentage` → `base_price * (1 - percent/100)`
   - `formula` → `base = resolveBase(item)`; then `price = base * (1 - discount/100) + surcharge`; then clamp by `min_margin` / `max_margin` against cost; then `roundTo(price, price_round)` with `price_round` semantics = "round to the nearest multiple of".
5. `resolveBase(item)`: `list_price` | `standard_price` (cost) | another pricelist (**recursive**, with a depth cap of 5 and cycle detection — Odoo has neither and it is a real hang).
6. Currency-convert if the pricelist currency ≠ config currency.
7. Add `price_extra` from selected `no_variant` attribute values.

**Interaction with `price_type`**: a line with `price_type: 'manual'` is never repriced by a pricelist change; `'automatic'` (e.g. from a barcode-embedded price) likewise; only `'original'` lines are recomputed when the pricelist or fiscal position changes.

Both engines implement this; fixtures `010`–`030` cover it including the category-ancestor walk and the recursive base.

### 4.5 Tax computation — normative algorithm

Summarised here; `SPEC.md` carries the numbered long form.

**4.5.1 Inputs per line**: `quantity`, `price_unit`, `discount`, `tax_ids` (post-fiscal-position), `sign` (+1 sale, −1 refund), `currency`, `rounding_method`.

**4.5.2 Base determination**
```
gross      = price_unit * (1 - discount/100)
line_gross = gross * quantity
```
If any tax in the stack has `price_include = true`, `line_gross` is **tax-inclusive** and must be unwound. The unwind proceeds in **reverse sequence order** over the included taxes:

```
remaining = line_gross
for tax in reverse(included_taxes_by_sequence):
    if tax.amount_type == 'percent':
        tax_amount = remaining - remaining / (1 + tax.amount/100)
    elif tax.amount_type == 'fixed':
        tax_amount = tax.amount * quantity
    elif tax.amount_type == 'division':
        tax_amount = remaining * tax.amount/100          # tax on gross
    remaining -= tax_amount   (only if the tax is not include_base_amount for later taxes)
base = remaining
```

The `include_base_amount` flag controls whether a tax's amount joins the base of *subsequent* taxes (compound). `is_base_affected` controls whether a tax's own base includes *prior* taxes' amounts. These two flags are independent and both must be honoured — this is the single most common source of divergence and fixtures `003`, `004`, `007` pin it.

**4.5.3 Excluded taxes** are then applied forward over the resolved `base`, accumulating into the base for subsequent `is_base_affected` taxes.

**4.5.4 Negative factors**: a tax with `has_negative_factor` (repartition producing a negative line) is computed positively then signed; the *base* reported for that tax is unaffected.

**4.5.5 Rounding modes**
- `round_per_line` (Odoo's `tax_calculation_rounding_method = 'round_per_line'`): every per-line tax amount is rounded to `currency.rounding` before summation. Order totals are the sum of rounded parts.
- `round_globally`: per-line amounts are kept at full precision; rounding happens once per **tax** at the document level. Order total = sum of rounded per-tax amounts + rounded base.

Rounding function is **half-up away from zero** by default, configurable per currency (`half_even` for jurisdictions that require it). Implemented identically:

```php
BigDecimal::of($v)->toScale($dp, RoundingMode::HALF_UP)   // PHP
```
```ts
function roundTo(v: number, step: number, mode: RoundMode = 'half_up'): number {
  const q = v / step;
  const r = mode === 'half_even' ? roundHalfEven(q) : Math.sign(q) * Math.round(Math.abs(q));
  return Number((r * step).toFixed(12));      // kill the 1e-13 tail before it propagates
}
```

That `toFixed(12)` re-normalisation is not cosmetic — without it, `0.1 + 0.2` style residue accumulates across a 60-line tab and produces a one-cent divergence roughly once per 3 000 orders. Fixture `060` was written specifically to catch it.

**4.5.6 Cash rounding** is applied *after* the order total, only when the config enables it and (optionally) only for cash payments:

```
rounded_total = roundTo(total, cash_rounding.rounding, cash_rounding.mode)   // up | down | half_up
rounding_delta = rounded_total - total
```
`rounding_delta` becomes an explicit ledger line at session close and an explicit receipt line. `only_round_cash_method` means the rounding is computed at payment time against the cash tender rather than the order total — the client must therefore recompute `amountDue` per payment method, which is why `OrderTotals` exposes both `total` and `roundedTotal`.

**4.5.7 Refund sign handling.** A refund order carries `sign = -1` at the *document* level. The engine computes on absolute values and applies the sign at the very end, to every output (base, tax, total). Rounding happens on the **positive** magnitude and is then signed. This matters: `roundTo(-0.125, 0.01, 'half_up')` under "round half away from zero" gives `-0.13`, but under naive `Math.round` gives `-0.12`. Fixture `050` pins it and the PHP `RoundingMode::HALF_UP` in `brick/math` is already away-from-zero, so the TS side is the one that needs the explicit `Math.sign(q) * Math.round(Math.abs(q))` shown above.

**4.5.8 Fiscal positions** are applied *before* the engine runs: `taxes_after_fp = fiscalPosition.map(product.tax_ids)`, where the map is a list of `{src_tax_id, dest_tax_id | null}` pairs; `null` means the tax is dropped. A source tax with multiple destination entries expands to several taxes. Unmapped taxes pass through unchanged. Both implementations share fixture-verified `mapTaxes()`.

---

## 5. Realtime

### 5.1 Why Reverb, and what it is *not* for

Reverb carries **change notifications and small state deltas**. It is explicitly **not** the sync transport: every realtime event has a REST fallback that produces the same result, and the client is correct (just slower) with websockets permanently down. This is the inverse of Odoo, where the bus is load-bearing for multi-device consistency, and it is the reason our degradation story is simple.

### 5.2 Channel catalogue

| Channel | Type | Members | Purpose |
|---|---|---|---|
| `private-pos.config.{configId}` | private | Registers + KDS of this config | Order/session/catalog changes, config-wide broadcasts |
| `private-pos.session.{sessionId}` | private | Same | Session lifecycle |
| `private-pos.device.{deviceId}` | private | One device | Targeted commands: revoke, reload, print job, customer-display push |
| `private-kds.{screenId}` | private | One KDS screen | Prep tickets routed to this screen |
| `presence-pos.config.{configId}.devices` | presence | Registers of this config | Who is online; drives "3 terminals connected" and the multi-tab guard |
| `pos.self.{configToken}` | public | Self-order clients of this config | Menu/product availability changes, kiosk open/closed |
| `pos.order.{orderAccessToken}` | public | One customer's phone | That order's state changes and payment result |
| `private-pos.table.{tableId}` | private | Registers | Table occupancy / merge / transfer |

**Public channels carry only what the token already grants.** `pos.order.{accessToken}` is a public channel whose name *is* the capability — knowing the name is knowing the secret, which is exactly the property we want for an anonymous customer. Nothing sensitive (costs, margins, other orders) ever goes on a public channel.

### 5.3 Authorization

```php
// routes/channels.php
Broadcast::channel('pos.config.{configId}', function ($user, int $configId) {
    // $user here is the Sanctum token's owner: a PosDevice
    return $user instanceof PosDevice
        && $user->pos_config_id === $configId
        && $user->revoked_at === null
        && $user->tokenCan('pos:realtime');
});

Broadcast::channel('pos.device.{deviceId}', fn ($user, string $deviceId) =>
    $user instanceof PosDevice && $user->id === $deviceId);

Broadcast::channel('kds.{screenId}', function ($user, int $screenId) {
    return $user instanceof PosDevice
        && $user->tokenCan('pos:kds')
        && KdsScreen::whereKey($screenId)->where('pos_config_id', $user->pos_config_id)->exists();
});

Broadcast::channel('pos.config.{configId}.devices', function ($user, int $configId) {
    return $user instanceof PosDevice && $user->pos_config_id === $configId
        ? ['id' => $user->id, 'name' => $user->name, 'kind' => $user->kind]
        : false;
});
```

Devices authenticate the broadcasting endpoint with their Sanctum bearer token; configure `broadcasting.php` auth middleware to `['auth:sanctum']` and point Echo at `/broadcasting/auth` with the `Authorization` header. Public self-order channels need no auth callback.

### 5.4 Event catalogue

All events implement `ShouldBroadcast`, carry a `v` (payload version) and an `emitted_by_device_id` so the originating device can ignore its own echo, and are **thin**: an id and enough context to decide whether to pull, never a full record graph. Rationale — a fat event is a second, unversioned, untested serialization path; a thin event is a cache-invalidation hint.

```php
// app/Events/Pos/OrderChanged.php
final class OrderChanged implements ShouldBroadcast
{
    public function __construct(
        public readonly int $configId,
        public readonly string $orderUuid,
        public readonly ?int $orderId,
        public readonly string $state,
        public readonly ?int $tableId,
        public readonly string $serverRev,
        public readonly string $updatedAt,
        public readonly ?string $emittedByDeviceId,
    ) {}

    public function broadcastOn(): Channel { return new PrivateChannel("pos.config.{$this->configId}"); }
    public function broadcastAs(): string { return 'order.changed'; }
}
```

| Event | Channel | Payload | Consumer action |
|---|---|---|---|
| `order.changed` | config | `{order_uuid, order_id, state, table_id, server_rev, updated_at, emitted_by_device_id}` | If not mine and I hold this order, or it is on a table I display → pull `GET /orders?uuids=` |
| `order.deleted` | config | `{order_uuid, reason}` | Purge locally, warn if it was open on this device |
| `table.status` | config, table | `{table_id, occupied, order_count, guest_count, total_client, since}` | Repaint floor plan |
| `table.merged` / `table.unmerged` | config | `{parent_id, child_ids}` | Repaint |
| `prep.ticket` | `kds.{screenId}` | `{ticket_id, order_uuid, course_index, kind: new\|cancel\|note, lines[], table, guests, fired_at}` | Render a ticket. **This one is fat** — a KDS ticket must appear instantly and the KDS is a display, not a source of truth. |
| `prep.ticket.acknowledged` | config | `{ticket_id, screen_id, state}` | Register shows "kitchen received" |
| `prep.line.state` | config, kds | `{ticket_id, line_uuid, state: todo\|doing\|done}` | Cross-screen KDS coordination |
| `payment.status` | device, `pos.order.{token}` | `{order_uuid, payment_uuid, status: pending\|authorized\|captured\|failed\|cancelled, terminal?}` | Payment screen state machine; customer phone |
| `session.state` | config, session | `{session_id, state, by_device_id}` | On `closing`/`closed`: flush, refuse new orders, reload |
| `catalog.changed` | config, `pos.self.{token}` | `{models: ['products','pricelist_items'], since}` | Debounced (2 s) `sync/pull` for the listed models |
| `product.availability` | config, self | `{variant_ids: [..], available: bool}` | Immediate in-memory patch; no pull needed |
| `device.command` | device | `{command: 'reload'\|'wipe'\|'ping'\|'open_drawer'\|'print', args}` | Remote administration |
| `device.revoked` | device | `{}` | Wipe local data, show pairing screen |
| `customer_display.update` | device | `{order_snapshot}` | Remote second screen (fat by necessity) |
| `selforder.order.state` | `pos.order.{token}` | `{state, tracking_number, paid}` | Customer's status page |
| `selforder.config.status` | `pos.self.{token}` | `{open: bool, reason}` | Kiosk enable/disable ordering |

**Debouncing at the source.** `catalog.changed` is emitted from a queued listener with a 2-second `Cache::lock` coalescing window; a bulk price import must not emit 40 000 events. Same for `table.status`.

**Broadcast from the queue, always.** Every event is `ShouldBroadcast` (queued), never `ShouldBroadcastNow`, except `payment.status` and `prep.ticket`, which are latency-critical and go on a dedicated `realtime` Horizon queue with its own workers so a slow report job cannot delay a card terminal.

### 5.5 Client wiring

```ts
// packages/data/src/realtime/echo.ts
export function connectRealtime(deps: { token: string; configId: number; deviceId: string }) {
  const echo = new Echo({
    broadcaster: 'reverb',
    key: import.meta.env.VITE_REVERB_APP_KEY,
    wsHost: import.meta.env.VITE_REVERB_HOST,
    wsPort: Number(import.meta.env.VITE_REVERB_PORT),
    forceTLS: import.meta.env.VITE_REVERB_SCHEME === 'https',
    enabledTransports: ['ws', 'wss'],
    authEndpoint: '/broadcasting/auth',
    auth: { headers: { Authorization: `Bearer ${deps.token}` } },
  });

  const config = echo.private(`pos.config.${deps.configId}`);
  config
    .listen('.order.changed', (e: OrderChangedPayload) => {
      if (e.emitted_by_device_id === deps.deviceId) return;      // ignore own echo
      syncEngine.scheduleOrderPull(e.order_uuid);
    })
    .listen('.catalog.changed', (e) => syncEngine.scheduleDeltaPull(e.models))
    .listen('.session.state', (e) => sessionStore.applyRemoteState(e));

  echo.connector.pusher.connection.bind('state_change', ({ current }: any) => {
    netStore.setSocket(current);                                  // connected | connecting | unavailable
    if (current === 'connected') syncEngine.reconcile();          // catch up on what we missed
  });

  return echo;
}
```

`syncEngine.reconcile()` on reconnect is essential: websockets guarantee nothing about messages sent while disconnected. Reconnect always triggers (a) an outbox drain, (b) a `sync/pull` from the current watermark, and (c) an open-orders reconciliation (`GET /api/v1/pos/{config}/orders/open?since=`) that returns both the open-order set and `deleted_uuids` — Odoo's `read_config_open_orders`.

### 5.6 Graceful degradation

Three-tier connectivity model, each tier independently observable:

```ts
export interface NetworkState {
  browserOnline: boolean;       // navigator.onLine — necessary, wildly insufficient
  serverReachable: boolean;     // last /api/v1/ping succeeded within 20s
  socket: 'connected' | 'connecting' | 'unavailable';
  lastServerContactAt: number | null;
  pendingCount: number;
}
```

| Socket state | Behaviour |
|---|---|
| `connected` | Event-driven. Safety `sync/pull` every 5 minutes anyway. |
| `connecting` (< 30 s) | No UI change. Echo's own backoff handles it. |
| `unavailable` | **Polling fallback**: `GET /api/v1/pos/{config}/changes?since=` every 10 s (15 s with jitter for >5 devices) returning the same event shapes as a batch. Subtle navbar indicator "live updates paused". Everything still works. |
| Server unreachable | Full offline mode. Banner. Outbox accumulates. `/ping` every 2 s for the first minute, then every 10 s. |

The KDS is the one surface that degrades *visibly*: without a socket or polling it cannot receive new tickets, so it shows a prominent stale-data banner with the age of the last update. A kitchen silently missing orders is far worse than a kitchen that knows it is blind.

Reverb capacity: one Reverb process handles ~2–5 k concurrent connections comfortably. Sizing assumption is ≤ 20 devices per venue, so a single Reverb container serves hundreds of venues; scale horizontally behind a sticky load balancer with the Redis scaling driver (`REVERB_SCALING_ENABLED=true`) when needed.

---

## 6. Sequences & references

Three distinct numbers, routinely conflated, with different requirements.

| Number | Example | Must work offline | Must be gapless | Scope | Authority |
|---|---|---|---|---|---|
| **Order reference** | `26D03-3-000412` | **Yes** | No | Global, forever | Client |
| **Session sequence number** | `412` | No | **Yes** | Per session | Server |
| **Tracking number** | `042` | **Yes** | No (reused) | Per session, short | Client |
| **Receipt/portal token** | `K7F2Q` | Yes | No | Global | Client |
| **Invoice number** | `INV/2026/00417` | No | **Yes, legally** | Per journal/year | Server |

### 6.1 Order reference (offline, collision-free)

```
{YY}D{deviceSeq:02}-{configId}-{counter:06}
26D03-3-000412
```

- `YY` — two-digit year, protects against counter reuse after a device wipe across a year boundary.
- `deviceSeq` — the small integer allocated at pairing (`pos_devices.device_seq`), **unique per config**, allocated by the server under a row lock on `pos_configs`. This is the entire collision-avoidance mechanism: two devices can never mint the same reference because their namespaces are disjoint.
- `counter` — monotonic per device, persisted in IndexedDB `meta['seq.order']`, incremented **before** use and flushed synchronously.

```ts
// packages/domain/src/sequence/orderReference.ts
export async function nextOrderReference(meta: MetaStore, device: DeviceInfo): Promise<string> {
  const counter = await meta.increment('seq.order');       // atomic within a Dexie rw txn
  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  return `${yy}D${String(device.device_seq).padStart(2, '0')}-${device.config_id}-${String(counter).padStart(6, '0')}`;
}
```

**Counter recycling.** Odoo recycles unused numbers when a draft order is abandoned. We do **not**. Gaps in a non-legal reference are harmless, and recycling introduces a reuse hazard that is not worth the tidiness. Gaplessness is provided where it is actually required (session sequence, invoice number) by the server.

**Device wipe.** If a device is re-paired it gets a **new** `device_seq` (the old one is retired, never reused within the same year), so a wiped device restarting its counter at 1 cannot collide with its own history.

**Server-side guard.** `pos_orders` has `UNIQUE (pos_config_id, reference)`. On the astronomically unlikely violation the ingest service appends `-R{n}` and emits a `reference_collision` warning rather than failing the order.

### 6.2 Session sequence number

Assigned at ingest, gapless within a session, used for the human-facing order name:

```php
$seq = DB::selectOne(
    'UPDATE pos_sessions SET order_seq = order_seq + 1 WHERE id = ? RETURNING order_seq',
    [$session->id],
)->order_seq;

$order->sequence_number = $seq;
$order->name = sprintf('%s/%05d', $config->sequence_prefix, $seq);   // "Bar/00412"
```

A single-statement `UPDATE … RETURNING` under the ingest transaction. Gapless because a failed ingest rolls the whole transaction back.

### 6.3 Tracking number

The 2–3 digit number shouted across the counter. Must exist offline, must be short, may repeat across days.

```ts
tracking = String(counter % 1000).padStart(3, '0');
```

Same device counter, mod 1000, so two devices *can* collide (device 1's #412 and device 2's #412). For counter-service venues that matters, so the client prefixes with a per-device letter when the config has >1 register: `A412` / `B412`. Kiosk uses `K`, mobile self-order `S` — matching Odoo's convention so staff muscle memory transfers.

### 6.4 Receipt / portal token

5 characters from an unambiguous alphabet (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — no 0/O/1/I) = 32⁵ ≈ 33.5 M. Generated client-side with `crypto.getRandomValues`. Collisions are handled server-side by a unique index and regeneration at ingest (the customer's printed receipt carries the client token, so on regeneration the server also stores the original as `receipt_token_alias` and the portal accepts both). Rare enough to be an acceptable edge; frequent enough at scale to need handling.

### 6.5 Invoice numbers

Never client-side. Allocated by a dedicated `SequenceAllocator` using a Postgres advisory lock per (journal, period), gapless, audited, with the year-reset policy configured per journal. If an order is invoiced while offline-queued, the invoice is generated at ingest with the ingest timestamp, and the receipt printed at the till says "invoice to follow" rather than inventing a number.

---

## 7. Printing & hardware

### 7.1 The central decision: a receipt document IR, not a canvas

Odoo renders receipts as **HTML → canvas → JPEG → raster ESC/POS**. That is a legitimate choice (it supports arbitrary CSS and any script) with real costs: 200–600 ms per print on a tablet, 30–80 kB per receipt over the wire to the printer, fuzzy text on 203-dpi thermal heads, no printer-side font rendering, and a hard dependency on `document`/fonts being loaded.

We invert it. The client produces a **`ReceiptDoc`** — a small, serializable intermediate representation — and *renderers* turn it into whatever the target needs:

```ts
// packages/domain/src/receipt/doc.ts
export type ReceiptNode =
  | { t: 'text'; v: string; style?: TextStyle }
  | { t: 'row'; left: string; right: string; style?: TextStyle }   // dot-leader aligned
  | { t: 'cols'; cells: Array<{ v: string; w: number; align?: Align }> }
  | { t: 'rule'; char?: string }
  | { t: 'feed'; n: number }
  | { t: 'image'; key: string; align?: Align }        // resolved from the blob store
  | { t: 'qr'; data: string; size?: 1|2|3|4|5|6|7|8; ec?: 'L'|'M'|'Q'|'H' }
  | { t: 'barcode'; data: string; symbology: 'ean13'|'code128'; height?: number }
  | { t: 'cut'; mode?: 'full' | 'partial' }
  | { t: 'pulse'; pin?: 0 | 1; on?: number; off?: number }         // cash drawer
  | { t: 'group'; children: ReceiptNode[]; style?: TextStyle };

export interface TextStyle {
  bold?: boolean; underline?: boolean; align?: Align;
  size?: 'sm' | 'md' | 'lg' | 'xl';       // → ESC/POS GS ! width/height multipliers
  invert?: boolean;
}

export interface ReceiptDoc {
  width: 32 | 42 | 48;                     // characters at font A
  codepage: 'cp437' | 'cp858' | 'cp1252' | 'utf8';
  nodes: ReceiptNode[];
  meta: { orderUuid: string; kind: 'receipt' | 'bill' | 'prep' | 'cash_move' | 'report'; copy: number };
}
```

Renderers:

| Renderer | Target | Notes |
|---|---|---|
| `toEscPos(doc, profile)` | `Uint8Array` | **Primary.** Native printer fonts, ~2 kB per receipt, instant, crisp. |
| `toEposXml(doc)` | ePOS-Print XML | Epson TM-i network printers over HTTP(S). |
| `toReact(doc)` | JSX | On-screen preview, `window.print()` fallback, receipt email HTML. |
| `toCanvas(doc)` | `HTMLCanvasElement` | Raster fallback (§7.3) and the source for emailed JPEG receipts. |

`ReceiptDoc` is also structured-cloneable, so it crosses to a worker or a print agent unchanged, and it is trivially snapshot-testable — a receipt regression test is `expect(buildReceiptDoc(order)).toMatchSnapshot()`, which is worth a great deal compared with pixel-diffing a canvas.

**When we still rasterize**: scripts the printer's codepage cannot express (Arabic, Thai, Devanagari, CJK on a printer without the font ROM), or a customer-supplied logo/promo block with real typography. The renderer decides per-node: `{t:'text'}` nodes whose content falls outside the selected codepage are automatically promoted to `{t:'image'}` by rendering that run to an offscreen canvas and dithering it. So we get native speed for the 95 % case and full fidelity for the rest, node by node rather than page by page.

### 7.2 ESC/POS generation

`packages/domain/src/receipt/escpos.ts` — pure, dependency-free, no DOM:

```ts
export function toEscPos(doc: ReceiptDoc, p: PrinterProfile): Uint8Array {
  const b = new ByteBuilder();
  b.raw(ESC, 0x40);                                     // ESC @  initialize
  b.raw(ESC, 0x74, p.codepageId);                       // ESC t  select codepage
  for (const node of doc.nodes) emit(b, node, doc, p);
  if (p.autoCut) b.raw(GS, 0x56, 0x41, 0x10);           // GS V A  feed & partial cut
  return b.build();
}
```

`PrinterProfile` captures the model-specific dialect (codepage table ids, image command — `GS v 0` vs `ESC *`, QR support via `GS ( k` vs "render as image", cut command, drawer pin timing, max raster width). Profiles ship for Epson TM-T20/T88, Star TSP100/mC-Print, Bixolon SRP-350, and a conservative `generic` profile. Profile selection is a config field with an autodetect attempt over the device's identity response.

Image nodes are dithered with **Floyd–Steinberg** (same as Odoo) into 1-bit rasters at the profile's dot width.

### 7.3 Transports

Ranked by preference; the client tries them in order and remembers what worked per printer.

**1. ePOS-over-network (Epson TM-i / TM-intelligent).** `POST http(s)://{ip}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000` with a SOAP-ish ePOS XML body. No drivers, no pairing, works from any device on the LAN, supports status polling (paper out, cover open, offline). **This is the recommended hardware for new installs.**

Mixed-content is the trap: an HTTPS page cannot `fetch()` an HTTP printer. Mitigations, in order:
- Printers that support HTTPS with a self-signed cert (Epson's certified-domain scheme: the serial maps to `<serial>.printer.epson.net` resolving to the LAN IP with a valid Epson-issued cert) — this is why Odoo does that odd serial→domain conversion, and we replicate it.
- Chrome's **Private Network Access**: `fetch(url, { targetAddressSpace: 'private' })` plus the printer answering the preflight. Requires the user to grant the local-network permission; we surface a first-run dialog explaining it, exactly as Odoo's LNA flow does.
- Fall back to the print agent (below).

**2. WebUSB.** `navigator.usb.requestDevice({ filters: [{ classCode: 7 }] })` (printer class), then bulk-out the ESC/POS bytes. Zero infrastructure, works on Chromium desktop and Android. Costs: a user gesture per device grant (persisted afterwards), and on Windows the printer must not be claimed by a kernel driver — practically this means "install as a generic USB device", which is a support burden. Offered as a first-class option; documented as second choice.

```ts
async function printWebUsb(bytes: Uint8Array, dev: USBDevice) {
  if (!dev.opened) await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  const iface = dev.configuration!.interfaces.find(i =>
    i.alternate.interfaceClass === 7)!;
  await dev.claimInterface(iface.interfaceNumber);
  const ep = iface.alternate.endpoints.find(e => e.direction === 'out')!;
  for (const chunk of chunked(bytes, 4096)) await dev.transferOut(ep.endpointNumber, chunk);
}
```

**3. WebSerial.** For serial/RS-232 and USB-serial printers, and for cash drawers and scales on COM ports. `navigator.serial.requestPort()` + a writable stream. Same permission model as WebUSB.

**4. Bluetooth (WebBluetooth).** Mobile waiter terminals with belt printers. Supported for printers exposing the standard SPP-over-GATT profile. Marked experimental.

**5. Print agent.** A small Go/Node binary installed on one machine per venue, exposing `https://localhost:9100` with a locally-trusted certificate (generated at install and added to the OS trust store), speaking a tiny JSON protocol (`POST /print {printerId, base64}`). This is the escape hatch that makes *any* printer work — including Windows spooler printers, label printers, and A4 report printers — and it replaces Odoo's IoT Box for venues that need it. It also handles the mixed-content problem for HTTP-only network printers, and it can drive a cash drawer wired to a printer that the browser cannot reach.

**6. `window.print()`.** Last resort, using `toReact(doc)` in a hidden iframe with an `@page { size: 80mm auto; margin: 0 }` stylesheet. Always available, always ugly.

**Printer registry** (client-side, persisted per device):

```ts
interface PrinterBinding {
  id: string;
  role: 'receipt' | 'prep' | 'report' | 'label';
  categoryIds: number[];              // prep routing (pos categories)
  transport: 'epos' | 'webusb' | 'webserial' | 'bluetooth' | 'agent' | 'browser';
  address: string;                    // ip | usb device signature | agent printer id
  profile: PrinterProfileId;
  status: { online: boolean; paper: 'ok' | 'low' | 'out'; cover: 'ok' | 'open'; checkedAt: number };
}
```

Status polled every 30 s for ePOS/agent printers; surfaced in the navbar and used to pre-empt the "receipt did not print" support call.

### 7.4 Cash drawer

The drawer is wired to the printer's RJ-11 kick port. `{ t: 'pulse', pin: 0, on: 25, off: 250 }` → `ESC p m t1 t2`. It can be emitted as part of a receipt doc (opens as the receipt prints) or as a standalone one-node doc (no-sale open). Every standalone open writes an audit entry `{employee_id, reason, at, approval_uuid?}` and requires the `cash.drawer.no_sale` ability. Drawer-open-on-cash-payment is a config flag.

### 7.5 Barcode scanner

HID keyboard-wedge is the dominant hardware and needs no permissions, so it is the primary path.

```ts
// packages/hardware/src/scanner/hidScanner.ts
export function createHidScanner(opts: { maxIntervalMs?: number; minLength?: number } = {}) {
  const maxInterval = opts.maxIntervalMs ?? 30;    // scanners emit keys ~1-5ms apart
  const minLength   = opts.minLength ?? 4;
  let buf = ''; let last = 0; let timer: number | undefined;

  return function onKeyDown(e: KeyboardEvent, emit: (code: string) => void) {
    const now = performance.now();
    if (now - last > maxInterval) buf = '';
    last = now;

    if (e.key === 'Enter') {
      if (buf.length >= minLength) { emit(buf); e.preventDefault(); e.stopPropagation(); }
      buf = '';
      return;
    }
    if (e.key.length === 1) {
      buf += e.key;
      // Suppress the keystroke from reaching inputs only once we're confident it's a scan.
      if (buf.length >= minLength) e.preventDefault();
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => { buf = ''; }, maxInterval * 4);
  };
}
```

Attached at `document` level in the capture phase. Interaction with the numpad buffer is the subtle part Odoo gets right and we replicate: **the number buffer delays acting on digits by `maxIntervalMs`**, so a scan of `5901234123457` does not become a quantity of 5 901 234 123 457 before the scanner finishes.

Nomenclature parsing (`packages/domain/src/barcode/`) supports rule types `product`, `variant`, `weight`, `price`, `discount`, `customer`, `employee`, `lot`, plus **GS1-128** composite parsing (AI 01/02/10/17/30/310n…) and the padded-GTIN zero-strip fallback. Two nomenclatures (primary + fallback) as in Odoo.

Also supported: camera scanning via `BarcodeDetector` where available (Chromium Android/desktop) with a `zxing-wasm` fallback, and serial scanners via WebSerial.

### 7.6 Customer display

Two transports, one payload.

```ts
export interface CustomerDisplayFrame {
  v: 1;
  kind: 'idle' | 'order' | 'payment' | 'qr' | 'weight' | 'thanks';
  order?: { lines: DisplayLine[]; subtotal: string; tax: string; total: string;
            paid: string; change: string; currency: CurrencyFormat };
  qr?: { data: string; caption: string };
  weight?: { value: string; unit: string; tare: string; unitPrice: string; total: string };
  brand: { logoUrl: string | null; message: string | null };
  at: number;
}
```

- **Same machine, second monitor**: a `BroadcastChannel('pos-display')` from the register, consumed by `/display` opened in a second window (or a `window.open` with `screenX` on the secondary display). Zero latency, works fully offline.
- **Separate device (tablet on the counter)**: the register `POST /api/v1/pos/devices/{displayDeviceId}/display` and the server relays over `private-pos.device.{id}` as `customer_display.update`. Requires network; the display shows a soft "reconnecting" state rather than freezing.

The register emits a frame on every `order.rev` change, debounced to 100 ms and dropped if identical to the previous frame.

### 7.7 Scale

`iface_electronic_scale` + a scale binding. Transports: WebSerial (most scales are RS-232 speaking a simple ASCII protocol — Toledo/Dialog 06, CAS, Mettler SICS) or the print agent (`GET /scale/read`). Poll at 4 Hz while the weighing dialog is open, never otherwise.

```ts
export interface ScaleReading { weight: number; unit: 'kg' | 'lb' | 'g'; stable: boolean; tare: number; at: number }
```

Legal-metrology rule replicated from Odoo: a product may only be added at a weight that **differs from the previously accepted weight**, and only when `stable === true`. Both are enforced in `packages/hardware/src/scale/` and covered by unit tests, because in several jurisdictions this is a certification requirement rather than a nicety.

### 7.8 Payment terminals

An interface, not implementations, in v1:

```ts
export interface PaymentTerminal {
  readonly id: string;
  readonly capabilities: { refund: boolean; reversal: boolean; tipAdjust: boolean; partialApproval: boolean };
  requestPayment(req: { orderUuid: Uuid; paymentUuid: Uuid; amount: string; currency: string }): Promise<void>;
  cancelPayment(paymentUuid: Uuid): Promise<void>;
  refund(req: { orderUuid: Uuid; paymentUuid: Uuid; amount: string }): Promise<void>;
  subscribe(cb: (s: TerminalStatus) => void): () => void;
}
```

State machine: `idle → requesting → waiting_card → processing → (approved | declined | cancelled | timeout) → settled`. Terminal results arrive either directly (LAN terminal, local HTTP) or via webhook → `payment.status` Reverb event. **A terminal payment is never considered captured on client evidence alone**: the payment row reaches `captured` only when the server says so. Offline card payments are therefore either impossible (correct, and what most acquirers require) or explicitly "offline-authorized" with the risk recorded on the order.

---

## 8. PWA specifics

### 8.1 Service worker strategy per asset class

`injectManifest` mode — we write the SW by hand and let Workbox inject the precache manifest. Generated-SW mode does not survive contact with an app that must decide, per request, whether "no network" is an error or the normal case.

```ts
// resources/js/apps/register/sw.ts
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setDefaultHandler } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);            // hashed JS/CSS/fonts/icons + the shell

// 1. App shell — every /register/* navigation resolves to the precached shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/register/index.html'), {
  allowlist: [/^\/register\//],
}));

// 2. Immutable hashed build assets — cache-first, they can never change under a URL.
registerRoute(({ url }) => url.pathname.startsWith('/build/'), new CacheFirst({
  cacheName: 'build-assets',
  plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 90 })],
}));

// 3. Fonts — cache-first, long TTL. Receipts need them before printing.
registerRoute(({ request }) => request.destination === 'font',
  new CacheFirst({ cacheName: 'fonts', plugins: [new ExpirationPlugin({ maxEntries: 20 })] }));

// 4. Product images — cache-first with an LRU cap; images are nice-to-have, never blocking.
registerRoute(({ url }) => url.pathname.startsWith('/storage/products/'), new CacheFirst({
  cacheName: 'product-images',
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }),
  ],
}));

// 5. API — NEVER cached. IndexedDB is the offline data store; a cached API response
//    would be a second, unsynchronised source of truth. This is the rule Odoo also
//    enforces (it skips /web/dataset) and it is non-negotiable.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

// 6. Everything else — network, no cache.
setDefaultHandler(new NetworkOnly());

self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
```

| Asset class | Strategy | Cache | Why |
|---|---|---|---|
| App shell HTML | Precache + `NavigationRoute` | `workbox-precache` | The whole offline story depends on it |
| Hashed JS/CSS | Precache / CacheFirst | `build-assets` | Content-addressed, immutable |
| Fonts | CacheFirst | `fonts` | Receipt rendering blocks on font load |
| Icons/manifest | Precache | precache | Install experience |
| Product images | CacheFirst + LRU 3000 + `purgeOnQuotaError` | `product-images` | Large, optional, evictable |
| Company logo / receipt assets | Precache **at runtime** into `blobs` (IndexedDB, not SW cache) | Dexie | Must survive cache eviction; receipts are legally required |
| `/api/**` | NetworkOnly | — | Single source of truth is IndexedDB |
| `/broadcasting/auth` | NetworkOnly | — | Auth |

Note the deliberate split: **the SW cache holds assets; IndexedDB holds data and anything legally required.** Browsers evict SW caches under pressure far more readily than they evict IndexedDB from an installed, persisted origin.

### 8.2 Manifests

One per app, served from `public/manifests/`.

```jsonc
// public/manifests/register.webmanifest
{
  "name": "POS Register",
  "short_name": "Register",
  "id": "/register/",
  "start_url": "/register/",
  "scope": "/register/",
  "display": "fullscreen",
  "display_override": ["window-controls-overlay", "fullscreen", "standalone"],
  "orientation": "landscape",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "categories": ["business", "productivity"],
  "prefer_related_applications": false,
  "icons": [
    { "src": "/icons/register-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/register-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/register-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Open tickets", "url": "/register/tickets" },
    { "name": "Close session", "url": "/register/session/close" }
  ]
}
```

- **Register**: `fullscreen`, `landscape`. A till should not show browser chrome or rotate.
- **KDS**: `fullscreen`, `landscape`, dark theme, `/kds/`.
- **Self-order**: `standalone`, `portrait` for mobile; the kiosk variant uses `fullscreen` and is launched in a kiosk-mode browser anyway.

The **self-order manifest is dynamic** — its `name`, `theme_color`, and icon come from the venue's branding, so it is served by a controller (`GET /manifests/self/{config}.webmanifest`) with a 1-hour `Cache-Control`, exactly the trick Odoo uses for its scoped app.

### 8.3 Install flow

```ts
// packages/data/src/pwa/install.ts
let deferred: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as any; installStore.setAvailable(true); });

export async function promptInstall() {
  if (!deferred) return 'unavailable';
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome;                       // 'accepted' | 'dismissed'
}
```

- **Register/KDS**: the setup wizard *requires* install before the device can be paired for production use (a soft requirement — a "continue in browser" link exists, with a warning that offline reliability is reduced). Installed = the OS keeps the storage bucket, the shell launches without chrome, and Android grants a persistent storage prompt.
- On iOS (`beforeinstallprompt` unsupported) we show illustrated Share → Add to Home Screen instructions. iOS is a supported-with-caveats platform: no Background Sync, no `persist()` guarantee, 7-day eviction for non-installed sites. **Installing is mandatory on iOS** and the app refuses to run in Safari tabs for register/KDS with an explanatory screen.
- **Storage persistence** is requested immediately after pairing:

```ts
if (navigator.storage?.persist) {
  const persisted = await navigator.storage.persist();
  if (!persisted) telemetry.warn('storage.not_persisted');
}
```

### 8.4 Update & reload strategy

Silent auto-update is wrong for a register: swapping the bundle mid-transaction is how you lose an order.

```ts
// registerSW with prompt, but gated on app state
const updateSW = registerSW({
  immediate: false,
  onNeedRefresh() { updateStore.setPending(true); },
  onOfflineReady() { toast('Ready to work offline'); },
});

// Applied only when it is safe:
autorun(() => {
  if (!updateStore.pending) return;
  const safe = orderStore.noOpenOrders()
            && outbox.isEmpty()
            && sessionStore.state !== 'closing'
            && idleFor(60_000);
  if (safe) updateSW(true);            // skipWaiting + reload
});
```

Plus:
- A **manual "Update now"** button in the navbar whenever an update is pending, with the version number.
- A **forced update** path: if the manifest returns `min_client_version` above ours, we block the app with an update screen (after draining the outbox, if the network is up — which it must be, since we just got a manifest).
- `clientsClaim()` is **not** called on activation. We control the handover explicitly.
- Version is stamped into the bundle (`__APP_VERSION__` via `define`) and sent on every API request as `X-Client-Version` for observability.

### 8.5 Background sync

```ts
// in sw.ts
import { BackgroundSyncPlugin, Queue } from 'workbox-background-sync';

const orderQueue = new Queue('pos-order-sync', {
  maxRetentionTime: 60 * 24 * 7,        // one week, in minutes
  onSync: async ({ queue }) => {
    let entry;
    while ((entry = await queue.shiftRequest())) {
      try { await fetch(entry.request.clone()); }
      catch (err) { await queue.unshiftRequest(entry); throw err; }
    }
    const clientList = await self.clients.matchAll();
    clientList.forEach(c => c.postMessage({ type: 'SYNC_FLUSHED' }));
  },
});
```

**Strictly a bonus.** The in-page outbox (§3.6.4) is the primary mechanism and is fully correct on its own. Background Sync only helps when the tab is closed and the OS wakes the SW — unavailable on iOS and Firefox. The two must not double-send: the SW queue is only fed by requests that the page explicitly hands over on `pagehide`, and every push carries an `Idempotency-Key` so a double-send is harmless anyway.

`periodicsync` (`tag: 'pos-delta-pull'`, `minInterval: 12h`) is registered where permitted to keep the catalog warm on a device left idle overnight.

### 8.6 Storage quotas and eviction guards

Budget for a 5 000-product venue:

| Store | Size |
|---|---|
| Catalog (IndexedDB, JSON) | 6–12 MB |
| Orders (30 days retained locally) | 5–20 MB |
| Product images (SW cache, 3 000 @ ~15 kB webp) | ~45 MB |
| Build assets | ~4 MB |
| **Total** | **~60–80 MB** |

Chromium grants up to 60 % of free disk to an origin; even a full 32 GB tablet leaves gigabytes. iOS caps around 1 GB for installed PWAs. Both are comfortable — but only if we actively manage growth.

**Guards:**

```ts
export async function checkQuota(): Promise<QuotaState> {
  const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) ?? {};
  const ratio = quota ? usage / quota : 0;
  if (ratio > 0.9) return { level: 'critical', usage, quota };
  if (ratio > 0.7) return { level: 'warn', usage, quota };
  return { level: 'ok', usage, quota };
}
```

- Checked at boot and every hour.
- `warn` → run the pruner: drop `product-images` cache entries beyond the LRU cap, delete synced orders older than 7 days, vacuum the audit log.
- `critical` → drop the entire image cache (images are always re-fetchable), keep everything else, and raise a manager banner.
- **Order data is never auto-pruned while `syncState !== 'synced'`.** A pruner that can delete an unsynced sale is a defect, and the pruner has a unit test asserting exactly that.
- `purgeOnQuotaError: true` on image caches so a `QuotaExceededError` self-heals.
- A `QuotaExceededError` on a *write to the outbox* is treated as a P0: the app immediately drops all evictable caches, retries once, and if it still fails blocks new orders with an unmissable error rather than silently losing the sale.

**Local retention policy**: orders are kept locally for 30 days (configurable) after being synced, so the ticket list and reprints work offline; older ones are fetched on demand. `done` orders older than the window are deleted from IndexedDB by the nightly (on-boot) pruner.

---

## 9. Testing strategy

Test budget by layer, and what each layer is *for*:

| Layer | Tool | Count (target) | Runtime | Purpose |
|---|---|---|---|---|
| PHP unit | Pest | ~400 | < 20 s | Tax engine, pricing, sequences, ingest rules |
| PHP feature | Pest + `RefreshDatabase` | ~250 | < 90 s | Endpoints, auth, session lifecycle, accounting |
| TS unit | Vitest | ~600 | < 25 s | Tax engine, store reducers, outbox, ESC/POS, barcode |
| Tax parity | Pest **and** Vitest over shared fixtures | ~120 fixtures ×2 | < 5 s | The single most important suite in the repo |
| Component | Vitest + Testing Library | ~150 | < 60 s | Numpad, order summary, payment screen |
| E2E | Playwright | ~45 flows | < 12 min | Odoo tour equivalents |
| Offline sim | Playwright + CDP | ~15 | < 6 min | The scenarios that actually break in production |
| Load | k6 | 4 scenarios | nightly | Sync ingest under 200 concurrent registers |

### 9.1 PHP (Pest)

```php
// tests/Feature/Pos/OrderSyncTest.php
it('is idempotent under retry with the same idempotency key', function () {
    $device = PosDevice::factory()->register()->create();
    $payload = OrderSyncPayload::make()->withLines(3)->paid()->toArray();

    $a = $this->withDevice($device)
        ->withHeader('Idempotency-Key', 'k-1')
        ->postJson("/api/v1/pos/{$device->pos_config_id}/orders/sync", $payload);

    $b = $this->withDevice($device)
        ->withHeader('Idempotency-Key', 'k-1')
        ->postJson("/api/v1/pos/{$device->pos_config_id}/orders/sync", $payload);

    expect($b->json())->toEqual($a->json());
    expect(PosOrder::count())->toBe(1);
    expect(PosOrderLine::count())->toBe(3);
});

it('rewrites create commands to updates when the uuid already exists', function () { /* … */ });
it('reroutes an order to an open session when its session closed', function () { /* … */ });
it('creates a rescue session when no session is open', function () { /* … */ });
it('rejects a line discount above the config limit without an approval record', function () { /* … */ });
it('refuses to refund more than the remaining refundable quantity', function () { /* … */ });
it('produces a balanced closing entry for a mixed cash/card/pay-later session', function () { /* … */ });
it('never returns a 5xx for a malformed order — it returns per-order rejected', function () { /* … */ });
```

Feature tests for the whole session lifecycle (open → cash in/out → orders → closing control → validate → journal entry) with golden-file assertions on the resulting ledger lines. The closing-entry composition (report §1, §4) is intricate enough that snapshot-testing the generated journal entry against a committed fixture is the only tractable approach.

Static analysis: PHPStan level 8 on `app/Domain/**`, level 6 elsewhere. Pint for formatting. `--parallel` in CI.

### 9.2 TypeScript (Vitest)

```ts
// packages/data/src/sync/__tests__/outbox.test.ts
it('coalesces successive edits to the same order into one pending entry', async () => {
  const ob = createOutbox(memoryDb());
  await ob.enqueueOrderSync(orderA, diff1);
  await ob.enqueueOrderSync(orderA, diff2);
  expect(await ob.pending()).toHaveLength(1);
  expect((await ob.pending())[0].payload).toMatchObject(diff2);
});

it('does not mutate an in-flight entry; it queues a follow-up', async () => { /* … */ });
it('preserves ordering per target uuid under concurrent drains', async () => { /* … */ });
it('applies full-jitter exponential backoff capped at 30s', () => { /* … */ });
it('never drops an entry on a 5xx', async () => { /* … */ });
```

```ts
// packages/domain/src/pricing/__tests__/orderTotals.bench.ts
bench('50-line order, 3 tax groups, compound', () => computeOrderTotals(fixture50), { time: 500 });
// CI fails if mean > 3ms
```

Dexie is tested against `fake-indexeddb`, which is fast and deterministic; a smaller suite runs against real IndexedDB in Playwright to catch behaviours `fake-indexeddb` does not model (transaction auto-commit timing, blob storage).

### 9.3 Playwright E2E — the Odoo tour equivalents

Odoo's `tours/` are the de-facto acceptance suite for the POS. Each becomes a Playwright spec:

```
tests/e2e/
  register/
    open-session.spec.ts              ← opening control, cash count, float
    simple-sale.spec.ts               ← add product, pay cash, receipt
    tax-included-sale.spec.ts
    discount.spec.ts                  ← line %, manager-gated above limit
    price-override.spec.ts
    pricelist-switch.spec.ts
    fiscal-position-switch.spec.ts
    combo-product.spec.ts             ← configurator, free/extra split
    configurable-product.spec.ts      ← attributes, custom values, exclusions
    weighted-product.spec.ts          ← mocked scale
    lot-tracked-product.spec.ts
    split-payment.spec.ts
    cash-rounding.spec.ts
    refund-from-ticket.spec.ts        ← partial + full, sign checks
    tip.spec.ts
    invoice-at-sale.spec.ts
    customer-create-and-select.spec.ts
    barcode-scan.spec.ts              ← synthetic HID keystroke timing
    cash-in-out.spec.ts
    close-session.spec.ts             ← variance, manager override, journal entry assertion
    multi-order-tabs.spec.ts
    ticket-list-search.spec.ts
    reprint-receipt.spec.ts
  restaurant/
    floor-plan.spec.ts
    table-order-and-transfer.spec.ts
    table-merge-unmerge.spec.ts
    courses-fire.spec.ts
    split-bill.spec.ts
    guest-count.spec.ts
    prep-ticket-delta.spec.ts         ← NEW / CANCELLED / NOTE UPDATE
  selforder/
    qr-menu-consultation.spec.ts
    mobile-order-pay-each.spec.ts
    mobile-order-pay-meal.spec.ts     ← two phones, one table
    kiosk-order-terminal.spec.ts
    online-payment.spec.ts
  kds/
    ticket-lifecycle.spec.ts
    multi-screen-routing.spec.ts
  backoffice/
    device-pairing.spec.ts
    product-crud.spec.ts
    session-report.spec.ts
```

Hardware is mocked at the **transport boundary**, not the UI: `page.addInitScript` installs fake `navigator.usb`/`navigator.serial`/`fetch`-to-printer implementations that record the exact `Uint8Array` sent. That turns "did the receipt print correctly" into a byte-level assertion:

```ts
const bytes = await fakePrinter.lastJob();
expect(decodeEscPos(bytes)).toMatchSnapshot('simple-sale-receipt.txt');
```

### 9.4 Offline simulation tests

The highest-value suite, because these are the bugs that reach production.

```ts
// tests/e2e/offline/offline-flows.spec.ts
test('completes a full sale while offline and syncs on reconnect', async ({ page, context }) => {
  await bootRegister(page);
  await context.setOffline(true);

  await addProduct(page, 'Espresso', 2);
  await pay(page, 'Cash', '5.00');
  await expect(page.getByTestId('receipt')).toBeVisible();
  await expect(page.getByTestId('sync-badge')).toHaveText('1 pending');

  await context.setOffline(false);
  await expect(page.getByTestId('sync-badge')).toHaveText('Synced', { timeout: 15_000 });

  const order = await api.lastOrder();
  expect(order.state).toBe('paid');
  expect(order.amount_total).toBe('5.00');
});

test('cold-boots offline from cache and can sell', async ({ page, context }) => {
  await bootRegister(page);                    // warm the SW + IndexedDB
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('product-grid')).toBeVisible();
  await addProduct(page, 'Espresso', 1);
  await pay(page, 'Cash', '2.50');
});

test('survives a mid-sync crash without duplicating the order', async ({ page, context }) => {
  await context.route('**/orders/sync', route => route.abort('connectionaborted'));   // response lost
  await sellOne(page);
  await context.unroute('**/orders/sync');
  await expect(page.getByTestId('sync-badge')).toHaveText('Synced', { timeout: 20_000 });
  expect(await api.orderCount()).toBe(1);      // idempotency key did its job
});

test('a paid unsynced order survives a hard reload', async ({ page, context }) => { /* … */ });
test('two devices editing one table converge to a single order', async ({ browser }) => { /* … */ });
test('an order pushed after session close lands in a rescue session', async ({ page }) => { /* … */ });
test('quota pressure evicts images but never unsynced orders', async ({ page }) => { /* … */ });
test('websocket down falls back to polling and still shows the other device\'s order', async ({ page }) => { /* … */ });
```

Network conditions are driven through CDP (`Network.emulateNetworkConditions`) so we can test *slow* rather than only *absent* — a 3 s RTT with 5 % packet loss breaks different code than a clean offline flag, and is far more common in a basement bar.

### 9.5 CI pipeline

```
lint         → pint --test, eslint, tsc --noEmit, phpstan
unit         → pest --parallel --coverage (min 85% on app/Domain), vitest run --coverage
parity       → the tax corpus, both languages, in one job (fails loud, names the fixture)
build        → vite build (all apps), fail on bundle-size regression > 5%
e2e          → playwright, sharded ×4, against a docker-compose stack
offline-e2e  → playwright offline suite (separate job — slower, flakier, must still be green)
nightly      → generative tax fuzzing (10k cases), k6 load, Lighthouse PWA audit (min score 95)
```

---

## 10. Project structure

```
.
├── app/
│   ├── Console/Commands/
│   │   ├── PosSeedDemoCommand.php
│   │   ├── PosPruneTombstonesCommand.php
│   │   └── TaxVerifyCorpusCommand.php
│   ├── Domain/                                   # framework-light business core
│   │   ├── Pos/
│   │   │   ├── Models/                           # PosConfig, PosSession, PosOrder, PosOrderLine,
│   │   │   │                                     # PosPayment, PosDevice, PosPrinter, PosPreset…
│   │   │   ├── Bootstrap/
│   │   │   │   ├── BootstrapRegistry.php
│   │   │   │   ├── ManifestBuilder.php
│   │   │   │   └── Models/                       # one BootstrapModel per client-visible model
│   │   │   │       ├── ProductsBootstrap.php
│   │   │   │       ├── PricelistItemsBootstrap.php
│   │   │   │       └── …
│   │   │   ├── Sync/
│   │   │   │   ├── OrderIngestService.php        # the create→update rewrite, conflicts
│   │   │   │   ├── SessionResolver.php           # rescue-session logic
│   │   │   │   ├── IdempotencyStore.php
│   │   │   │   ├── ConflictResolver.php
│   │   │   │   └── DTO/
│   │   │   ├── Session/
│   │   │   │   ├── OpenSessionAction.php
│   │   │   │   ├── CashMoveAction.php
│   │   │   │   ├── ClosingControlDataQuery.php
│   │   │   │   └── ValidateSessionAction.php     # the closing journal entry
│   │   │   ├── Sequence/
│   │   │   │   ├── SessionSequenceAllocator.php
│   │   │   │   └── DeviceSeqAllocator.php
│   │   │   ├── Prep/                             # kitchen routing + ticket building
│   │   │   ├── Ability.php
│   │   │   └── Tombstones/
│   │   ├── Pricing/
│   │   │   ├── TaxEngine.php
│   │   │   ├── PricelistResolver.php
│   │   │   ├── FiscalPositionMapper.php
│   │   │   ├── CashRounding.php
│   │   │   └── Money.php
│   │   ├── SelfOrder/
│   │   │   ├── SelfOrderContext.php
│   │   │   ├── SanitizeSelfOrderAction.php       # whitelist + server-side reprice
│   │   │   └── TokenService.php
│   │   ├── Accounting/                           # journal entries, invoices, reconciliation
│   │   ├── Inventory/                            # pickings, lots, valuation hooks
│   │   └── Catalog/                              # products, variants, combos, attributes
│   ├── Events/Pos/                               # the §5.4 event catalogue
│   ├── Http/
│   │   ├── Controllers/
│   │   │   ├── Api/V1/Pos/
│   │   │   │   ├── BootstrapController.php
│   │   │   │   ├── SyncPullController.php
│   │   │   │   ├── OrderSyncController.php
│   │   │   │   ├── SessionController.php
│   │   │   │   ├── CashMoveController.php
│   │   │   │   ├── PartnerController.php
│   │   │   │   ├── ProductSearchController.php
│   │   │   │   ├── ApprovalController.php
│   │   │   │   ├── DeviceController.php
│   │   │   │   └── KdsController.php
│   │   │   ├── Backoffice/                       # Inertia controllers
│   │   │   ├── SelfOrder/                        # public self-order endpoints
│   │   │   └── Portal/                           # receipt lookup, online payment
│   │   ├── Middleware/
│   │   │   ├── EnsureTokenIsDevice.php
│   │   │   ├── ResolveSelfOrderContext.php
│   │   │   ├── HandleIdempotency.php
│   │   │   └── HandleInertiaRequests.php
│   │   ├── Requests/
│   │   └── Resources/
│   ├── Jobs/                                     # BroadcastCatalogChange, GenerateInvoice,
│   │                                             # SendReceiptEmail, BuildClosingEntry…
│   ├── Policies/
│   └── Support/
├── bootstrap/
├── config/
│   ├── pos.php                                   # abilities, limits, retention, feature flags
│   ├── reverb.php
│   ├── horizon.php
│   └── sanctum.php
├── database/
│   ├── factories/
│   ├── migrations/
│   └── seeders/
│       ├── DemoRestaurantSeeder.php
│       ├── DemoRetailSeeder.php
│       └── TaxSetupSeeder.php
├── resources/
│   ├── js/
│   │   ├── packages/
│   │   │   ├── domain/                           # zero deps — the shared core
│   │   │   │   ├── src/
│   │   │   │   │   ├── models/                   # Order, OrderLine, Payment, Product…
│   │   │   │   │   ├── pricing/                  # taxEngine.ts, pricelist.ts, cashRounding.ts,
│   │   │   │   │   │                             # orderTotals.ts, money.ts
│   │   │   │   │   ├── barcode/                  # nomenclature, gs1
│   │   │   │   │   ├── receipt/                  # doc.ts, escpos.ts, eposXml.ts, builders/
│   │   │   │   │   ├── prep/                     # order-change delta engine
│   │   │   │   │   ├── sequence/
│   │   │   │   │   ├── auth/                     # pin.ts, abilities.ts
│   │   │   │   │   └── generated/api-types.ts
│   │   │   │   └── package.json
│   │   │   ├── data/
│   │   │   │   └── src/
│   │   │   │       ├── db.ts                     # Dexie schema
│   │   │   │       ├── catalog/                  # in-memory indexes
│   │   │   │       ├── stores/                   # zustand slices
│   │   │   │       ├── sync/                     # pull.ts, push.ts, outbox.ts, reconcile.ts
│   │   │   │       ├── realtime/
│   │   │   │       ├── http/                     # api client, idempotency, retry
│   │   │   │       └── pwa/
│   │   │   ├── ui/
│   │   │   │   └── src/                          # Button, Numpad, Dialog, Money, ProductCard…
│   │   │   └── hardware/
│   │   │       └── src/                          # printers/, scanner/, scale/, drawer/, display/
│   │   ├── apps/
│   │   │   ├── backoffice/
│   │   │   │   ├── main.tsx
│   │   │   │   ├── Layouts/
│   │   │   │   └── Pages/                        # Inertia page components
│   │   │   ├── register/
│   │   │   │   ├── main.tsx
│   │   │   │   ├── sw.ts
│   │   │   │   ├── router.tsx
│   │   │   │   ├── screens/                      # Product, Payment, Receipt, Tickets, Floor,
│   │   │   │   │                                 # SplitBill, CloseSession, Login
│   │   │   │   ├── features/                     # numpad, scanner binding, prep dispatch
│   │   │   │   └── boot/
│   │   │   ├── kds/
│   │   │   ├── selforder/
│   │   │   └── display/
│   │   └── types/
│   ├── css/
│   ├── tax-spec/
│   │   ├── SPEC.md
│   │   └── fixtures/*.json
│   └── views/
│       ├── app.blade.php                         # Inertia root
│       └── shells/{register,kds,self,display}.blade.php
├── routes/
│   ├── web.php
│   ├── api.php
│   ├── public.php
│   ├── channels.php
│   └── console.php
├── tests/
│   ├── Unit/          Pricing/, Sync/, Sequence/
│   ├── Feature/       Pos/, SelfOrder/, Backoffice/, Api/
│   ├── e2e/           register/, restaurant/, selforder/, kds/, backoffice/, offline/
│   └── load/          k6 scripts
├── docker/
│   ├── php/Dockerfile
│   ├── nginx/default.conf
│   └── postgres/init.sql
├── compose.yaml
├── vite.config.ts
├── playwright.config.ts
├── vitest.config.ts
├── phpunit.xml
├── package.json                                  # workspaces root
└── tsconfig.json                                 # project references
```

---

## 11. Deployment & ops

### 11.1 docker-compose (development, and the shape of production)

```yaml
# compose.yaml
name: pos

services:
  app:                                  # php-fpm + the application code
    build: { context: ., dockerfile: docker/php/Dockerfile, target: dev }
    volumes: ['.:/var/www/html']
    environment:
      APP_ENV: local
      DB_CONNECTION: pgsql
      DB_HOST: postgres
      REDIS_HOST: redis
      BROADCAST_CONNECTION: reverb
      QUEUE_CONNECTION: redis
      CACHE_STORE: redis
      SESSION_DRIVER: redis
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_started } }

  nginx:
    image: nginx:1.27-alpine
    ports: ['8080:80']
    volumes: ['./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro', '.:/var/www/html:ro']
    depends_on: [app]

  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: pos, POSTGRES_USER: pos, POSTGRES_PASSWORD: pos }
    volumes: ['pgdata:/var/lib/postgresql/data', './docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro']
    ports: ['5432:5432']
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U pos'], interval: 5s, retries: 10 }

  redis:
    image: redis:7-alpine
    command: ['redis-server', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction']
    volumes: ['redisdata:/data']

  horizon:                              # queue workers
    build: { context: ., dockerfile: docker/php/Dockerfile, target: dev }
    command: ['php', 'artisan', 'horizon']
    volumes: ['.:/var/www/html']
    depends_on: [app, redis, postgres]
    stop_grace_period: 60s              # let in-flight jobs finish

  scheduler:
    build: { context: ., dockerfile: docker/php/Dockerfile, target: dev }
    command: ['php', 'artisan', 'schedule:work']
    volumes: ['.:/var/www/html']
    depends_on: [app]

  reverb:
    build: { context: ., dockerfile: docker/php/Dockerfile, target: dev }
    command: ['php', 'artisan', 'reverb:start', '--host=0.0.0.0', '--port=8080']
    ports: ['9000:8080']
    environment: { REVERB_SCALING_ENABLED: 'true', REVERB_HOST: 0.0.0.0 }
    volumes: ['.:/var/www/html']
    depends_on: [redis]

  vite:
    image: node:22-alpine
    working_dir: /app
    command: ['sh', '-c', 'npm ci && npm run dev -- --host 0.0.0.0']
    ports: ['5173:5173']
    volumes: ['.:/app', 'node_modules:/app/node_modules']

  mailpit:
    image: axllent/mailpit
    ports: ['8025:8025']

  minio:                                # S3-compatible storage for product images/receipts
    image: minio/minio
    command: ['server', '/data', '--console-address', ':9001']
    environment: { MINIO_ROOT_USER: pos, MINIO_ROOT_PASSWORD: pospospos }
    ports: ['9002:9000', '9001:9001']
    volumes: ['miniodata:/data']

volumes: { pgdata: {}, redisdata: {}, miniodata: {}, node_modules: {} }
```

Production differs in four ways only: `target: prod` (opcache preload, no volume mount, assets baked in), Reverb behind a TLS terminator with sticky sessions and `REVERB_SCALING_ENABLED=true`, Horizon split across two containers (see below), and Postgres/Redis as managed services.

### 11.2 Queues

```php
// config/horizon.php  (production supervisors)
'environments' => [
    'production' => [
        'realtime' => [                 // latency-critical: broadcasts, payment status, prep tickets
            'connection' => 'redis', 'queue' => ['realtime'],
            'balance' => 'auto', 'minProcesses' => 2, 'maxProcesses' => 10,
            'tries' => 5, 'timeout' => 15, 'memory' => 256,
        ],
        'default' => [                  // ingest side-effects: pickings, costs, notifications
            'connection' => 'redis', 'queue' => ['default'],
            'balance' => 'auto', 'minProcesses' => 2, 'maxProcesses' => 20,
            'tries' => 5, 'timeout' => 120, 'memory' => 512,
        ],
        'heavy' => [                    // invoices, PDFs, closing entries, exports, imports
            'connection' => 'redis', 'queue' => ['heavy'],
            'balance' => 'auto', 'minProcesses' => 1, 'maxProcesses' => 6,
            'tries' => 3, 'timeout' => 900, 'memory' => 1024,
        ],
    ],
],
```

Queue assignment rules:
- **Order ingest itself is synchronous**, inside the HTTP request. A register waiting for its order id must not wait for a queue. The transaction is short (a handful of upserts + the tax recomputation) and is the single hottest path in the system — budget **p99 < 250 ms for a 20-line order**.
- Everything downstream of ingest is queued: stock picking creation, cost/margin computation, invoice generation, receipt email, analytics rollups.
- Session validation (the closing journal entry) is queued on `heavy` with a job-level lock per session; the client polls `GET /sessions/{id}/closing-status` and the KDS/registers get `session.state` broadcasts.
- **Failed jobs**: `failed_jobs` monitored; a failure on `realtime` pages, a failure on `heavy` opens a ticket.

Scheduled tasks (`routes/console.php`):

```php
Schedule::command('pos:prune-tombstones')->dailyAt('03:15');
Schedule::command('pos:alert-stale-sessions')->hourly();      // sessions open > 24h
Schedule::command('horizon:snapshot')->everyFiveMinutes();
Schedule::command('pos:reconcile-idempotency')->dailyAt('04:00');
Schedule::command('telescope:prune --hours=48')->daily();
```

### 11.3 Migrations & data

- **Migrations are additive in production.** Column drops go through a two-release deprecation (release N stops writing, release N+1 drops), because a register that has been offline for a week will push data shaped like release N.
- Every table carries `created_at`, `updated_at` (timestamptz), and client-visible tables carry a `updated_at` index — the delta-sync watermark depends on it. `updated_at` is maintained by a Postgres trigger, not only by Eloquent, so bulk imports and manual fixes still produce correct deltas:

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

- Key indexes: `pos_orders (pos_config_id, updated_at)`, `pos_orders (pos_session_id, state)`, `pos_orders (uuid) UNIQUE`, `pos_orders (pos_config_id, reference) UNIQUE`, `pos_order_lines (pos_order_id)`, `pos_order_lines (uuid) UNIQUE`, `pos_tombstones (model, deleted_at)`, `products (updated_at)`, partial index `pos_sessions (pos_config_id) WHERE state <> 'closed' AND NOT is_rescue` backing the one-open-session constraint.
- **Zero-downtime deploys**: `php artisan migrate --force` runs before the new code is swapped in; the app is `down --render` only for genuinely breaking migrations, and even then registers keep selling offline and sync afterwards — which is the whole point of the architecture.

### 11.4 Seeding demo data

```bash
php artisan pos:seed-demo --scenario=restaurant --config="Le Bistro" --devices=3 --orders=250
php artisan pos:seed-demo --scenario=retail --config="Corner Shop" --products=5000
```

`DemoRestaurantSeeder` produces a complete, self-consistent venue that every E2E test and every demo runs against:

- 1 company, EUR, `round_per_line`, Belgian tax setup (21 % / 12 % / 6 % price-included, one compound eco-tax for fixture coverage).
- 1 `pos_config` "Le Bistro" with restaurant mode, 3 payment methods (Cash, Card, Customer account), cash rounding 0.05 half-up, kitchen printers.
- 2 floors, 18 tables (2 merged pairs), 3 presets (Dine-in / Takeaway / Delivery).
- ~120 products across 9 POS categories: 3 combos (menu deals), 4 configurable (attributes with price extras), 2 weighted, 1 lot-tracked, 1 tip product.
- 2 pricelists (Standard, Happy Hour with a time window and a category rule) exercising all six `compute_price` types.
- 8 employees across the three roles with known PINs (`1111` cashier, `2222` supervisor, `9999` manager) — **only when `APP_ENV !== 'production'`**, guarded by an explicit check in the seeder.
- 3 paired devices with fixed uuids so E2E tests can pair deterministically.
- 250 historical orders spread over 14 days with realistic mix (refunds, invoiced, split payments, cancelled) so reports and the ticket list have content.

`--scenario=retail` gives the large-catalog stress case: 5 000 products, 3 000 partners, 1 register — the configuration used to validate boot time and Dexie hydration budgets.

### 11.5 Observability

| Signal | Tool | What we watch |
|---|---|---|
| Errors (server) | Sentry | Ingest rejections by code, `amount_mismatch` rate |
| Errors (client) | Sentry browser SDK, with offline buffering | Boot failures, IndexedDB errors, quota errors, print failures |
| Traces | Laravel Telescope (staging), OpenTelemetry → Tempo (prod) | Ingest p50/p95/p99, bootstrap duration |
| Queues | Horizon dashboard + Prometheus exporter | Queue wait time per supervisor, failed job rate |
| Realtime | Reverb `/health` + connection gauge | Connected devices vs paired devices |
| Business | A `pos_device_heartbeats` table fed by `TouchDeviceLastSeen` | Devices with pending orders > 15 min, devices not seen > 1 h during opening hours |

The two alerts that matter most, and that we would not have thought to add without reading how Odoo fails:

1. **`unsynced_orders_age`** — any order with `syncState != synced` older than 30 minutes on a device that has contacted the server since. This is the "money is stuck on a tablet" alarm.
2. **`amount_mismatch_rate`** — client vs server total divergence. A step change means the two tax engines have drifted, and it will show up here days before an accountant notices.

Both are reported by the client on every successful sync (a small `client_health` block on the sync request) so they work even when the device is otherwise silent.

---

## 12. Appendix — decision log

| # | Decision | Alternative rejected | Reason |
|---|---|---|---|
| 1 | Register/KDS/self-order as SPA islands on precached shells | Inertia pages with SW-cached HTML | Props-bearing documents cannot be coherently precached; offline cold boot is a hard requirement |
| 2 | Compile-time TypeScript domain model | Runtime schema discovery (Odoo's `load_data_params`) | Types are known at build time; runtime discovery buys nothing and costs type safety |
| 3 | Manifest + per-model paginated bootstrap | One monolithic bootstrap call | Resumable, cacheable, observable, parallel |
| 4 | Zustand + Immer for orders, frozen index for catalog | Redux Toolkit / MobX / Jotai / one big store | Ceremony vs. legibility vs. structural-sharing cost over megabytes |
| 5 | `rev`-keyed memoized totals | Fine-grained reactive derived cells | Our derived values are whole-order recomputations, not cells |
| 6 | Plain-object records, behaviour in pure functions | Class instances (Odoo's `Base` subclasses) | Structured-cloneable → worker, IndexedDB, BroadcastChannel all work unchanged |
| 7 | ORM-command-style diff payloads | Full-order push every time | 400 bytes vs 40 kB on a flaky link |
| 8 | Three idempotency layers (header key, uuid unique, create→update rewrite) | Just uuid uniqueness | Each covers a distinct failure: lost response, retry with new key, coalesced commands |
| 9 | Rescue sessions instead of rejecting late orders | Reject with "no open session" | Never lose a real sale to a bookkeeping constraint |
| 10 | Monetary values as strings on the wire | JSON numbers | Doubles on the wire are how cents get lost |
| 11 | `BigDecimal` server-side, `number` + explicit rounding client-side | bignum on both sides | Bignum breaks structured cloning; rounding discipline + the parity corpus makes doubles safe |
| 12 | Shared JSON fixture corpus, run by Pest and Vitest | Codegen one language from the other | Codegen across PHP/TS is fragile; fixtures test behaviour, which is what actually matters |
| 13 | Thin realtime events + REST fallback | Fat events as the sync mechanism | An unversioned second serialization path; and correctness must not depend on websockets |
| 14 | ESC/POS document IR as primary print path | HTML→canvas→raster (Odoo's approach) | 10× faster, 20× smaller, crisper, snapshot-testable — with per-node raster promotion for scripts that need it |
| 15 | Device-namespaced offline order references | Server-allocated references | Receipts must print before the network answers |
| 16 | No counter recycling | Odoo's unused-number recycling | Gaps in a non-legal reference are harmless; reuse is a hazard |
| 17 | Separate SW per PWA scope | One root-scope SW | Customer phones must not precache the register bundle |
| 18 | API responses never cached by the SW | SWR on API GETs | A second, unsynchronised source of truth next to IndexedDB |
| 19 | Update applied only when the register is idle and drained | `autoUpdate` / `skipWaiting` immediately | Swapping the bundle mid-transaction loses orders |
| 20 | Explicit `SelfOrderContext`, no user impersonation | Odoo's `with_user(default_user)` | Impersonating a real account from an anonymous public endpoint is a standing escalation hazard |
| 21 | Offline PIN as attribution, manager approvals as the control | Treating PIN as an authorization boundary | Offline PINs are brute-forceable by construction; be honest and put the control where it holds |
| 22 | Order ingest synchronous, everything downstream queued | Fully queued ingest | The register must get its id and authoritative amounts in the response |

---

*End of spec-03-architecture.md*
