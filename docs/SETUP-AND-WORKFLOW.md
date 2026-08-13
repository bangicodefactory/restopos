# RestoPOS — Setup, Configuration & End‑to‑End Workflow

A practical, hands‑on guide to **getting RestoPOS running**, **configuring each surface**, and
understanding **how an order flows end‑to‑end** across the register, kitchen display, self‑order
PWA and back‑office.

This complements the reference material:

- [`README.md`](../README.md) — one‑paragraph overview + the idealized quick‑start.
- [`docs/spec/03-architecture.md`](spec/03-architecture.md) — the normative architecture (sync, realtime, PWA, printing).
- [`docs/spec/05-api-contract.md`](spec/05-api-contract.md) — every endpoint, event and Inertia page.
- [`docs/CONVENTIONS.md`](CONVENTIONS.md) — the fixed entry points every surface agrees on.

> Everything below has been exercised against the demo seed. Where a step differs from the
> README's happy path (dev drivers, ports, Vite host), the working command is given and the reason
> is noted.

---

## 1. The four surfaces at a glance

One Laravel app, one database, one domain layer — four front‑ends, each a fixed entry point
(see [`docs/CONVENTIONS.md`](CONVENTIONS.md) §"Fixed entry points"):

| Surface | URL | Auth principal | Kind |
|---|---|---|---|
| **Back‑office** | `/` | a **User** (email + password) | Inertia SPA, always online |
| **Register** | `/pos/{config}` | a **PosDevice** (paired) + an **Employee** (PIN) | PWA, offline‑capable |
| **Kitchen display** | `/kitchen/{display}` | a **PosDevice** (paired) | PWA |
| **Self‑order** | `/menu/{configToken}` | anonymous (config token + optional table token) | PWA / kiosk |
| **Customer display** | `/pos/{config}/display` | companion of a paired register | screen |

The register is the heart: after its first bootstrap it runs entirely from IndexedDB and only the
network‑dependent bits (pairing, first data load, sync replay) touch the server.

**This document is for whoever runs the stack.** The people who run a *service* on it — cashiers,
managers, kitchen staff — read [`docs/manual/`](manual/index.md), which is published as a site by
the `Publish Manual` workflow. What is in it, and what CI requires of it, is described in
[`docs/CONVENTIONS.md`](CONVENTIONS.md) §"Documentation".

---

## 2. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| PHP | 8.3+ (8.4 works) | needs `ext-bcmath`, `ext-json` |
| Composer | 2.x | resolves from Packagist normally |
| Node | 20+ (26 works) | ships with npm |
| Database | PostgreSQL 14+ **or** SQLite | Postgres for prod; **SQLite is fine for development** |
| Redis | optional | only if you use the redis cache/queue drivers; dev can use `database`/`file` |
| Docker | optional | the `docker compose` path bundles Postgres + Redis + Reverb |

---

## 3. Setup

### 3a. With Docker (bundles Postgres + Redis + Reverb)

```bash
cp .env.example .env
docker compose up -d
docker compose exec app php artisan key:generate
docker compose exec app php artisan migrate --seed
```

Open <http://localhost:8000> → sign in as `admin@restopos.test` / `password`.

### 3b. Local, minimal dev stack (SQLite, no Postgres/Redis)

This is the fastest way to a running app on a bare machine — no external services.

```bash
composer install
npm install
cp .env.example .env
php artisan key:generate
```

Point the app at SQLite and local drivers (the shipped `.env.example` defaults to Postgres + Redis
+ Reverb). Edit `.env`:

```dotenv
DB_CONNECTION=sqlite       # (comment out DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD)
QUEUE_CONNECTION=database  # was redis
CACHE_STORE=database       # was redis
SESSION_DRIVER=database    # already the default
```

Create the SQLite file, then migrate + seed the demo restaurant:

```bash
touch database/database.sqlite     # Windows: New-Item database/database.sqlite -ItemType File
php artisan migrate --seed
```

### 3c. Local, production‑like stack (Postgres + Redis + Reverb)

Keep `.env.example`'s defaults, create the `restopos` Postgres database and a Redis instance, then:

```bash
composer install && npm install
cp .env.example .env && php artisan key:generate
php artisan migrate --seed
```

### 3d. Running the stack

The one‑liner runs **all five dev processes** (server + queue + reverb + log tail + Vite):

```bash
composer dev
```

Under the hood that is `php artisan serve`, `php artisan queue:listen`, `php artisan reverb:start`,
`php artisan pail`, and `npm run dev`, via `concurrently`. Open <http://localhost:8000>.

**Running the processes by hand** (useful when a port is taken or you want to control hosts —
see the gotchas in §8):

```bash
php artisan serve --host=127.0.0.1 --port=8000     # web + API + Inertia
npm run dev                                        # Vite (assets + HMR)
php artisan reverb:start                            # websockets (realtime)
php artisan queue:listen --tries=1 --timeout=0     # jobs: broadcasts, kitchen tickets, prints
```

- The web server and Vite are always required.
- **Reverb + the queue worker are only needed for realtime** (live kitchen tickets, cross‑device
  updates). You can browse the back‑office and register without them.
- The **queue worker matters for broadcasts**: `ShouldBroadcast` events (e.g. a new kitchen ticket)
  are queued, so with no worker running they never reach Reverb.

---

## 4. Configuration

All configuration is environment‑driven (`.env`) plus a handful of `config/*.php` files. The keys
that matter:

### App

```dotenv
APP_NAME=RestoPOS          # also drives VITE_APP_NAME → the browser tab title on every PWA
APP_ENV=local
APP_KEY=                   # `php artisan key:generate`
APP_DEBUG=true
APP_URL=http://localhost
APP_LOCALE=en              # UI defaults to French per venue; back-office honours this
```

### Database

```dotenv
DB_CONNECTION=pgsql        # or `sqlite` for dev
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=restopos
DB_USERNAME=restopos
DB_PASSWORD=
```

Money is `decimal(16,4)`; never switch a monetary column to a float.

### Cache / queue / session / broadcast

```dotenv
CACHE_STORE=redis          # `database` or `file` for a no-Redis dev box
QUEUE_CONNECTION=redis      # `database` for a no-Redis dev box
SESSION_DRIVER=database
BROADCAST_CONNECTION=reverb # the realtime driver
```

Pairing codes live in the **cache** (single‑use, 10‑min TTL) — so cache must be shared between the
web process and the queue worker (`database`/`redis` both are; `array` is not).

### Reverb (realtime — spec 03 §5)

```dotenv
REVERB_APP_ID=restopos
REVERB_APP_KEY=restopos-key
REVERB_APP_SECRET=restopos-secret
REVERB_HOST=localhost      # what the browser connects to (VITE_REVERB_HOST mirrors it)
REVERB_PORT=8080
REVERB_SCHEME=http
REVERB_SERVER_HOST=0.0.0.0 # what the reverb process binds
REVERB_SERVER_PORT=8080

VITE_REVERB_APP_KEY="${REVERB_APP_KEY}"
VITE_REVERB_HOST="${REVERB_HOST}"
VITE_REVERB_PORT="${REVERB_PORT}"
VITE_REVERB_SCHEME="${REVERB_SCHEME}"
```

The `VITE_*` copies are baked into the client bundle at Vite start; change them → restart `npm run dev`.

### Sanctum (device + SPA auth)

```dotenv
SANCTUM_STATEFUL_DOMAINS=localhost,localhost:5173,127.0.0.1,127.0.0.1:8000
```

If you serve the app on a **different host/port** (e.g. `127.0.0.1:8001`), add it here or the
back‑office login will 419. Devices authenticate with bearer **Sanctum tokens**, not cookies.

### POS behaviour (`config/pos.php`)

```dotenv
POS_MIN_CLIENT_VERSION=1.0.0   # a client older than this is refused at bootstrap
POS_PAIRING_TTL=600            # pairing-code lifetime, seconds
POS_PRODUCT_PAGE_SIZE=1000
POS_CUSTOMER_PAGE_SIZE=100
POS_DISCOUNT_LIMIT=30          # % discount above which a manager PIN is required
POS_AUTHORIZED_DIFF=0          # allowed cash-count difference at session close
POS_SELFORDER_THROTTLE="60,1"  # self-order rate limit (requests, minutes) per IP
POS_PAYMENT_PROVIDER=null      # ships with a NullProvider stub; no real gateway yet
```

Per‑venue settings (currencies, taxes, pricelists, floors, printers, self‑order mode, kiosk idle
timeout, VAT positions, etc.) live in the **database**, edited from the back‑office — not in `.env`.

---

## 5. The demo restaurant (what `--seed` gives you)

**Le Bistro Numérique** — a deterministic French‑Moroccan bistro:

- 74 products / 15 categories, with variants, combos and menus; a Happy Hour pricelist.
- **4 POS configs**: `1` Salle · `2` Bar · `3` Comptoir / À emporter · `4` Borne libre‑service.
- 3 floors, 24 tables; France VAT (10% on‑site / 20% alcohol / 5.5% takeaway) + a takeaway fiscal position.
- 2 kitchen displays (Cuisine chaude, Bar).
- ~126 historical orders over 30 days across 41 sessions, **plus a live session with draft orders on tables**.

**Credentials**

| Where | Identity | Secret |
|---|---|---|
| Back‑office (`/`) | `admin@restopos.test` | `password` |
| Register cashiers (PIN) | Amélie Rousseau · Karim Benali · Sofia Marchetti · Marc Lefèvre · Léa Dubois · Youssef El Amrani | `1234` · `2468` · `1357` · `4321` · `8642` · `9753` |

---

## 6. End‑to‑end workflow

### 6.0 The big picture

```
Back-office (User)                 configures the restaurant, catalogue, floors, employees,
   │                               printers, self-order — and mints device pairing codes
   ▼
Device pairing  ──►  a PosDevice token + HMAC secret land in the device's IndexedDB
   │
   ├── Register (Employee PIN) ── opens a session ── takes an order ──┐
   │                                                                  ├──► fires prep tickets
   └── Self-order (QR at table) ── menu ── cart ── checkout ──────────┘        │
                                                                               ▼
                                                                     Kitchen display (KDS)
                                                                     shows tickets live over Reverb
   Payment ──► order closes ──► outbox syncs to server (idempotent on UUID)
   Session close ──► cash count ──► accounting export
```

Two rules govern the whole flow (see README "Architecture in one page"):
**the server always recomputes totals** (the client total is a hint), and **sync is idempotent on
the client‑minted UUID**.

### 6.1 Back‑office — configure the restaurant

Sign in at `/` as `admin@restopos.test`. From here you manage the catalogue (Products, Variants,
Combos, Categories, Pricelists), the floor plan (Floors, Tables), Employees, Preparation printers,
POS configs and their self‑order settings, plus Orders, Sessions and reporting.

This is where a device's **pairing code** is generated (a POS config exposes
`POST /pos-configs/{config}/pairing-codes`), and where a table's QR token can be rotated.

### 6.2 Device pairing (register / kitchen / kiosk)

Every terminal is a `PosDevice` bound to one POS config. Pairing is a single‑use, 10‑minute code
(spec 03 §2.2):

1. **Back‑office** generates a code for a config, choosing the device kind
   (`register` · `kiosk` · `prep_display` · `customer_display`). The code lives in the cache, not a table.
2. The **fresh device** opens its URL (e.g. `/pos/1`, `/kitchen/{token}`), enters the code, and
   `POST /api/devices/pair` returns a Sanctum token, a per‑device HMAC secret and a
   `device_identifier` that namespaces its offline order references.
3. The token + non‑extractable HMAC key are stored in IndexedDB; the device is now paired forever
   (until revoked from the back‑office, which pushes `device.revoked` and the terminal wipes local data).

Abilities are per device kind (`config/pos.abilities`): a register gets `pos:sync/session/catalog/
print/realtime/restaurant`; a prep display gets `pos:catalog/kitchen/realtime`; a kiosk gets
`pos:catalog/selforder/realtime/print`.

**Dev helper** — mint a code without the UI:

```php
// php artisan tinker
$cfg = App\Models\Pos\PosConfig::find(1);                 // 1 = Salle
$svc = app(App\Services\Device\DevicePairingService::class);
echo $svc->createCode($cfg, App\Enums\DeviceType::Register, 'Caisse Salle')['code'];
```

### 6.3 Register — a full sale

1. **Boot**: `/pos/1` → the device bootstraps its catalogue (`GET /api/pos/bootstrap`, ETag‑cached),
   then runs from IndexedDB.
2. **Cashier login**: "Qui est en caisse ?" → pick an employee → enter the PIN. The PIN is verified
   **offline** against a per‑device HMAC verifier (`HMAC(device_secret, "pin:{id}:{sha256(pin)}")`);
   the plaintext PIN never leaves the device.
3. **Open the session** and take an order — tap products (attributes/combos open a configurator),
   quantities on the keypad. Totals compute live from the offline tax engine; VAT is per fiscal
   position (10% on‑site by default).
4. **Restaurant flow**: assign a table / guest count, split (`Diviser`), transfer (`Transférer`),
   and **fire courses to the kitchen** (`Envoyer`) — this creates prep tickets.
5. **Payment**: choose a method (Espèces / Carte bancaire / Ticket Restaurant / …), tender, `Valider`.
   A receipt renders; with no printer configured the browser fallback prints silently (no dialog).
6. **Close the session**: count the cash drawer (`POS_AUTHORIZED_DIFF` bounds the allowed diff),
   producing an accounting export.

Everything above works **offline**; the outbox replays to the server when the link returns.

### 6.4 Kitchen display (KDS)

`/kitchen/{displayToken}` pairs like any device (a `prep_display`). The board shows tickets in
stage columns (À faire → En cours → Prêt → Servi), with timers, late highlighting, category
routing and per‑line state. A cook taps a line to advance it (todo → in progress → ready → served).

New tickets arrive **live** over the private channel `kitchen.display.{token}` (event
`kitchen.ticket.created`). Broadcasts are *hints*: the board paints optimistically, then re‑pulls
the authoritative rows from `GET /api/kitchen/{display}/orders` — so a ticket only sticks if it is
backed by a real `prep_order`.

### 6.5 Self‑order (QR at table → kitchen)

1. A customer **scans the QR at their table** → opens `/menu/{configToken}?tt={tableToken}`.
   The config token is the POS config's `access_token`; the table token is `restaurant_tables.identifier`.
2. The PWA loads the menu (`GET /api/self-order/{configToken}/menu`), applies venue branding, and —
   because config 1 is in `table` service mode — shows a **Table T{n}** badge.
3. Browse → add to cart → checkout → **"Pay at the counter"** (order goes to the kitchen now, pay
   later) or **"Pay now"** (online payment intent).
4. `POST /api/self-order/{configToken}/orders` places the order. With a table in `pay-after-meal`
   mode it **appends to the table's open tab**, and `SelfOrderService::submitCart` **fires it to the
   kitchen** via `PreparationService::send` (so it lands on the KDS, tagged as a QR order,
   tracking `S###`, source `mobile`).

Whether a scan starts a new order or joins the table's tab is decided by the **config**, never the client.

### 6.6 Realtime (Reverb)

Broadcasts are thin — an id and a hint; the client then pulls authoritative rows. Channels are
capability‑shaped (spec 03 §5.2): `private-pos.config.{token}`, `private-pos.session.{id}`,
`private-kitchen.display.{token}`, plus two deliberately **public** ones for anonymous self‑order
(`pos.self.{token}`, `pos.order.{token}` — the channel name *is* the capability, and nothing
sensitive is emitted on them). `/broadcasting/auth` authenticates the **device** (not a user).

### 6.7 Offline & sync

The register's outbox queues every client‑created row (orders, lines, payments, courses), each with
a UUID minted on the terminal. `POST /api/pos/sync` upserts on that UUID, reconciles create↔update
races, reroutes orders whose session closed mid‑queue into a rescue session, and returns per‑record
results so one poisoned order cannot block the rest. The unique index on `uuid` is the real guard.

---

## 7. Everyday dev recipes

```bash
# Rebuild the pristine demo (deterministic)
php artisan migrate:fresh --seed

# Watch tests while developing
npm run test:watch
./vendor/bin/pest --watch    # if pest-watch is installed

# Typecheck + lint (both run in CI / `npm run build`)
npm run typecheck
npx eslint resources/js packages

# Tail logs (or use `php artisan pail`)
tail -f storage/logs/laravel.log
```

Reset a single paired device from the browser console (Application → IndexedDB), or from the
device's own "Réinitialiser cet appareil". Note the register and kitchen for the **same config
share one IndexedDB** (`getDb(configId)`), so resetting one re‑pairs the other.

---

## 8. Troubleshooting (gotchas seen in the wild)

| Symptom | Cause & fix |
|---|---|
| A **different app** appears on `:8000` | Another local project already holds the port; `php artisan serve` reports the port but the pre‑bound process answers. Run RestoPOS on a free port (`--port=8001`) and add it to `SANCTUM_STATEFUL_DOMAINS`. |
| **Blank white PWA**, no console error | The Vite hot file points at `http://0.0.0.0:5173` (unreachable). Start Vite bound to a real host: `npm run dev -- --host 127.0.0.1`. Kill any duplicate Vite instances (`:5173`/`:5174`) so the hot file is unambiguous. |
| Register/self‑order **503** on bootstrap | `php artisan serve` is single‑threaded; the register fires several parallel boot requests. Set `PHP_CLI_SERVER_WORKERS=8` and restart the server. |
| Live kitchen tickets never arrive | The **queue worker** isn't running — `ShouldBroadcast` events sit in the queue. Start `php artisan queue:listen`. |
| Pairing fails with a generic error | A stale/consumed code, or the client fingerprint exceeded the server's 128‑char cap (fixed in `resources/js/**/api.ts` / `shared/auth/device.ts`). Mint a fresh code. |
| Config‑driven features missing (payment methods, Tables tab) | The register's `configs` table wasn't hydrated. Clear `META.bootstrapEtag` (a re‑pair 304s on the config‑scoped ETag) or wipe the device DB and re‑pair. |
| A stuck **"Leave site?"** dialog blocks a reload | An in‑progress order marks the page dirty; dismiss the dialog, or reload in a fresh tab. |
| Tendering pops a native **print dialog** on a printer‑less till | Expected before the guard; now the no‑printer fallback prints silently. If it recurs, confirm the receipt binding is a `placeholder`. |

---

## 9. Where to go next

- **Data model** → [`docs/spec/01-schema.md`](spec/01-schema.md)
- **Feature parity + roadmap** → [`docs/spec/02-features.md`](spec/02-features.md)
- **Architecture (sync, realtime, PWA, printing)** → [`docs/spec/03-architecture.md`](spec/03-architecture.md)
- **Tax engine** → [`docs/spec/04-tax-engine.md`](spec/04-tax-engine.md)
- **API + events + Inertia props** → [`docs/spec/05-api-contract.md`](spec/05-api-contract.md)
- **Coding conventions** → [`docs/CONVENTIONS.md`](CONVENTIONS.md)
