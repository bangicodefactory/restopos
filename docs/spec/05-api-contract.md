# SPEC-05 — API contract

**Status**: normative. This is the interface three front-end agents (register, kitchen, self-order) and the back-office agent code against. Where this document and the implementation disagree, that is a bug in one of them — file it, do not paper over it.

**Companions**: `01-schema.md` (tables), `02-features.md` (feature IDs), `03-architecture.md` (why), `04-tax-engine.md` (money).

---

## 0. Conventions that apply to every endpoint

### 0.1 Money is a string

Every monetary value is a **decimal string** on the wire — `"24.20"`, never `24.2`. A JSON number round-trips through an IEEE-754 double on both ends and the register and the ledger must agree to the cent. Quantities are strings too (three decimal places). Ids are JSON numbers; uuids are strings.

Server-produced amounts carry the database's scale, so expect `"24.2000"` from a `decimal(16,4)` column and `"24.20"` from the tax engine's currency-rounded output. Parse, don't compare as strings.

### 0.2 Time

All timestamps are ISO-8601. Server-generated ones are UTC with a `Z` suffix and microsecond precision (`2026-07-28T09:12:44.512345Z`). Watermarks sent back as `?since=` may be any valid ISO-8601 instant; the server normalises them.

### 0.3 Identity

- **Client-created records** (orders, lines, payments, courses) are addressed by **uuid**, forever. The server `id` is a late-bound attribute; the client keys by uuid even after it learns the id.
- **Master data** is addressed by integer `id`.
- Route parameters named `{order}` accept a uuid or an id; `{display}` accepts an access token, uuid or id; `{table}` accepts an id, uuid or QR identifier.

### 0.4 Errors

Every non-2xx JSON response has the same envelope:

```jsonc
{ "error": { "code": "invalid_config_token", "message": "Self-order access denied." } }
```

| Status | `error.code` examples | Client treatment (spec 03 §3.6.6) |
|---|---|---|
| `401` | `missing_token`, `invalid_token` | Blocking modal — the device must re-pair |
| `403` | `forbidden`, `missing_ability:pos:sync`, `invalid_config_token`, `invalid_order_token` | Blocking; not retryable |
| `404` | `not_found`, `self_order_disabled` | Not retryable |
| `409` | `order_outdated` | Adopt server state, re-render, do not print |
| `410` | `device_revoked` | Wipe local data, show the pairing screen |
| `422` | `unprocessable`, plus Laravel's `{message, errors}` for validation | Per-record chip; edit-and-retry |
| `429` | `rate_limited` | Back off |

**`POST /api/pos/sync` is the exception**: it answers `200` whenever the envelope is well formed, and the per-order verdict lives inside `results[]`. A transport-level failure code there would make the outbox retry the whole batch including the orders that already succeeded.

### 0.5 Authentication

| Principal | Header / parameter | Endpoints |
|---|---|---|
| Device (register, KDS, kiosk, display) | `Authorization: Bearer {tokenId}\|{secret}` | `/api/pos/*`, `/api/kitchen/*`, `/api/devices/me` |
| Pairing code | request body | `POST /api/devices/pair` |
| Config token | path segment `{configToken}` or `?t=` | `/api/self-order/*` |
| Table token | `?tt=` | `/api/self-order/*` (optional) |
| Order token | `X-Order-Token` header (or `?order_token=`) | self-order order endpoints |
| User session | cookie | back-office (`/…`, Inertia) |

Device tokens carry **abilities** by device kind (`config/pos.php`):

| Kind | Abilities |
|---|---|
| `register` | `pos:sync`, `pos:session`, `pos:catalog`, `pos:print`, `pos:realtime`, `pos:restaurant` |
| `prep_display` | `pos:catalog`, `pos:kitchen`, `pos:realtime` |
| `kiosk` | `pos:catalog`, `pos:selforder`, `pos:realtime`, `pos:print` |
| `customer_display` | `pos:realtime` |
| `self_mobile` | `pos:catalog`, `pos:selforder` |

A route that needs an ability the token lacks answers `403 missing_ability:{ability}`.

**Everything under `/api/pos` and `/api/kitchen` is scoped to the device's own `pos_config`.** A config id never appears in a path. A device asking for another register's order gets `404`, not `403` — it does not get to learn that the order exists.

---

## 1. Devices

### `POST /api/devices/pair`

Enrol a fresh device with a short pairing code minted in the back-office. Throttled `10/min`. Auth: **none** — the code is the credential.

```jsonc
// request
{
  "code": "K7F2QM4B",              // required, 4–16 chars, case-insensitive
  "device_type": "register",       // optional: register|kiosk|customer_display|self_mobile|prep_display
  "name": "Bar terminal 2",        // optional
  "hardware_fingerprint": "…",     // optional
  "app_version": "1.4.0"           // optional
}
```

```jsonc
// 201
{
  "device": { "id": 3, "uuid": "0f8b…", "name": "Bar terminal 2", "device_identifier": 2, "device_type": "register" },
  "config": { "id": 1, "name": "Bar", "access_token": "9c4e…", "is_restaurant": true, "currency_id": 1 },
  "token": "12|8f2c…",             // shown once, never re-issued
  "abilities": ["pos:sync", "…"],
  "device_secret": "b3e1…",        // 64 hex chars; the HMAC key for offline PIN verification
  "server_time": "2026-07-28T09:12:44.512345Z",
  "min_client_version": "1.0.0",
  "schema_version": 1
}
```

`422 invalid_pairing_code` when the code is unknown, expired or already used (codes are single-use, TTL 10 min).

Store `token`, `device_secret` and `device.uuid` in **IndexedDB**, not `localStorage`: localStorage is synchronous, string-only, more readily scraped by injected script, and cleared by the same "clear site data" flows the service worker survives.

`device_identifier` is the small integer that namespaces this device's offline order references (`26D02-1-000412`, spec 03 §6.1). It is unique per config and never re-used.

### `GET /api/devices/me`

Auth: device. A cheap identity/liveness probe.

```jsonc
{ "device": { "id": 3, "uuid": "…", "name": "…", "device_identifier": 2, "device_type": "register", "pos_config_id": 1 },
  "server_time": "…", "min_client_version": "1.0.0" }
```

### `DELETE /api/devices/me`

Auth: device. Self-unpair (factory reset). `204`. Every token of the device is destroyed and it is marked inactive.

### `GET /api/ping`

Auth: none. `{ "ok": true, "server_time": "…", "min_client_version": "…", "schema_version": 1 }`. Used by the three-tier connectivity model (spec 03 §5.6).

---

## 2. Register — bootstrap & delta

### `GET /api/pos/bootstrap/manifest`

Auth: device + `pos:catalog`. Supports `If-None-Match`.

```jsonc
{
  "schema_version": 1,
  "min_client_version": "1.0.0",
  "dataset_fingerprint": "cfg1:r1:8f2c1a4b93de",
  "config_revision": 1,
  "server_time": "2026-07-28T09:12:44.512345Z",
  "device": { "id": 3, "uuid": "…", "name": "…", "device_identifier": 2, "device_type": "register" },
  "models": [
    { "name": "products", "count": 4820, "max_updated_at": "2026-07-27T18:22:01.004Z", "etag": "products:9f3c1a2b", "paginated": true },
    { "name": "taxes",    "count": 14,   "max_updated_at": "2026-05-02T10:00:00.000Z", "etag": "taxes:11aa33cd",  "paginated": false }
  ],
  "capabilities": { /* see below */ }
}
```

Returns `304` with no body when `If-None-Match` matches. The `ETag` is the `dataset_fingerprint` in quotes; it changes on any config edit and on any catalog write.

**`capabilities`** — the flags the client needs before the catalog has finished loading:

```jsonc
{ "restaurant": true, "self_order": "mobile", "preparation_display": true, "preparation_printers": false,
  "cash_control": true, "pricelists": false, "fiscal_positions": false, "presets": false,
  "employee_login": true, "loyalty": false, "tips": false, "split_bill": true, "global_discount": false }
```

### `GET /api/pos/bootstrap`

Auth: device + `pos:catalog`. Query: `models` (comma-separated payload keys), `since` (ISO-8601), `cursor` (opaque). Supports `If-None-Match` **only for a full load** — a request with `since` or `cursor` always executes.

```jsonc
{
  "schema_version": 1,
  "min_client_version": "1.0.0",
  "profile": "register",                       // register | self_order | prep_display
  "config_revision": 1,
  "dataset_fingerprint": "cfg1:r1:8f2c…",
  "server_time": "2026-07-28T09:12:44.512345Z",
  "watermark": "2026-07-28T09:12:43.512345Z",  // ← store THIS as the next `since`
  "limits":  { "products": 5000, "customers": 100, "delta_page_size": 500 },
  "capabilities": { … },
  "pagination": { "products":  { "cursor": "MTIwMA", "has_more": true, "limit": 5000, "total": 8321 },
                  "customers": { "cursor": null, "has_more": false, "limit": 100, "total": 42 } },
  "data": { "products": [ … ], "taxes": [ … ], "pos_config": { … }, "pos_session": { … } | null, "employees": [ … ] },
  "tombstones": { "products": [88, 91] }       // only present when `since` was given
}
```

`watermark` is `server_time` minus a one-second safety margin. Store it **only after the IndexedDB write commits**; upserts are idempotent so the one-second overlap costs nothing and eliminates the "one product never updates" class of bug.

**Payload keys in `data`**, in load order (dependency-first — apply them in this order and referential integrity holds at every commit point):

```
settings · decimal_precisions · currencies · cash_roundings
tax_groups · taxes · fiscal_positions · fiscal_position_taxes
uoms · pos_categories · product_categories · product_tags
products · product_variants · product_packagings
product_attributes · product_attribute_values · product_attribute_lines
product_attribute_line_values · product_attribute_exclusions
combos · combo_items
pricelists · pricelist_items
barcode_nomenclatures · barcode_rules
payment_providers · payment_methods
pos_presets · preset_service_windows · pos_notes · pos_bills · pos_printers
restaurant_floors · restaurant_tables · prep_displays
customers · pos_devices
pos_config (single object) · pos_session (single object or null) · employees
```

Rows are raw table rows (every column of the model's `posLoadFields()` for the profile). `pos_config` additionally carries `payment_method_ids`, `pricelist_ids`, `fiscal_position_ids`, `preset_ids`, `printer_ids`, `note_ids`, `bill_ids`, `trusted_config_ids` and `channel` (its broadcast channel name).

**`data.employees`** is the offline-auth block, computed per device (spec 03 §2.3):

```jsonc
{
  "id": 17,
  "name": "Amina B.",
  "role": "cashier",                 // minimal | cashier | manager
  "has_pin": true,
  "abilities": ["order.create", "line.discount", "…"],
  "pin_verifier":   "9c4e…",         // 64 hex chars, or null when no PIN is set
  "badge_verifier": "01af…"          // 64 hex chars, or null
}
```

Client-side verification:

```
pin_verifier   == HMAC-SHA256(device_secret, "pin:"   + employee_id + ":" + sha256_hex(pin))
badge_verifier == HMAC-SHA256(device_secret, "badge:" + employee_id + ":" + sha256_hex(badge))
```

Hash the typed PIN once, then HMAC it. The plaintext PIN never leaves the device and the server's stored hash never leaves the server; because the HMAC key is per-device, a bootstrap payload lifted from terminal A is useless on terminal B.

A PIN is an **attribution** control, not an authorisation boundary. Anything with financial consequence is re-checked server-side.

**Pagination.** `products` and `customers` are capped by `pos_configs.limited_product_count` / `limited_customer_count`. When `pagination.<model>.has_more` is true, repeat with `?models=<model>&cursor=<cursor>`. The cursor is opaque and keyed on the primary key — never `OFFSET`, which skips rows on a table being written to.

### `GET /api/pos/delta`

Auth: device + `pos:catalog`. Query: `since` (**required**, ISO-8601), `models` (optional).

Same envelope as `/bootstrap`, plus:

- `since` — echoed back
- `has_more` — true when any paginated model still has pages
- `data.pos_orders`, `data.pos_order_lines`, `data.pos_payments`, `data.restaurant_order_courses` — the open-order graph for this config *and its trusted peers*
- `tombstones.pos_orders` — **uuids** of orders that left the draft set (paid elsewhere, cancelled, merged, deleted)

Master-data tombstones are keyed by **id**; order tombstones by **uuid**, because the client may never have learned the id.

### `GET /api/pos/open-orders`

Auth: device + `pos:catalog`. Query: `since` (optional). Reconnect reconciliation — websockets guarantee nothing about messages sent while disconnected.

```jsonc
{ "server_time": "…", "records": [ … ], "lines": [ … ], "payments": [ … ], "courses": [ … ], "tombstones": ["uuid-…"] }
```

### `GET /api/pos/products`

Auth: device + `pos:catalog`. Query: `search`, `category_id`, `cursor`, `limit` (1–500, default 50).

```jsonc
{ "model": "products", "records": [ … ], "next_cursor": "MTIwMA" | null, "total": 8321, "server_time": "…" }
```

Matches on name, internal reference and barcode, case-insensitively.

### `GET /api/pos/customers`

Auth: device + `pos:catalog`. Query: `search`, `cursor`, `limit` (1–200, default 50). Same envelope with `"model": "customers"`. Search matches name, email, VAT and — for digit-only input — phone and mobile, so typing `475` finds `+32 475 …`.

---

## 3. Register — employee identity

### `POST /api/pos/employees/verify`

Auth: device. Throttled `30/min`. The **online** PIN/badge path; day-to-day switching is verified offline against the bootstrap verifiers. Use this when a server-signed answer is worth the round trip — manager approvals with real money behind them.

```jsonc
// request — supply (employee_id + pin) or badge
{ "employee_id": 17, "pin": "1234", "ability": "session.close.over_variance" }
```

```jsonc
// 200
{ "employee": { "id": 17, "name": "Amina B.", "role": "cashier", "abilities": ["…"] },
  "granted": false,                             // whether `ability` is in the list; true when `ability` is omitted
  "verified_at": "2026-07-28T09:31:02.913Z" }
```

`422 invalid_credentials` on any failure — deliberately uniform, so the response never reveals whether the employee exists.

**Ability catalogue** (`config/pos.php`, overridable per config):

| Role | Abilities |
|---|---|
| `minimal` | `order.create`, `order.line.add`, `receipt.print` |
| `cashier` | the above + `order.delete_draft`, `line.discount`, `refund.create`, `cash.in_out`, `session.open`, `session.close`, `receipt.reprint`, `table.transfer`, `table.merge`, `course.fire`, `bill.split`, `kitchen.send` |
| `manager` | the above + `order.void_paid`, `line.discount.above_limit`, `line.price_override`, `cash.in_out.delete`, `cash.drawer.no_sale`, `session.close.over_variance`, `session.rescue.close`, `report.margins`, `table.unmerge`, `kitchen.recall`, `config.manage` |

---

## 4. Register — push sync

### `POST /api/pos/sync`

Auth: device + `pos:sync`. Optional header `Idempotency-Key: {uuid}`.

```jsonc
{
  "client_version": "1.4.2",
  "client_time": "2026-07-28T09:31:02.144Z",
  "employee_id": 17,
  "orders": [
    {
      "uuid": "9f2c…",                       // required, 36 chars
      "op": "upsert",                        // upsert (default) | cancel | delete_draft
      "base_rev": "r55123:1785255336000",    // optional, last acked server_rev
      "order": {
        "session_id": 881,
        "state": "draft",                    // draft | paid | done | cancelled
        "source": "pos",                     // pos | mobile | kiosk | backoffice | api
        "access_token": "b9c1…",             // uuid; the customer-facing capability for this order
        "reference": "26D02-1-000412",       // client-minted, device-namespaced
        "tracking_number": "412",
        "ticket_code": "K7F2Q",
        "customer_id": 42,
        "employee_id": 17,
        "pricelist_id": 3,
        "fiscal_position_id": null,
        "preset_id": 1,
        "preset_time": null,
        "table_id": 12,
        "guest_count": 4,
        "floating_order_name": null,
        "general_customer_note": null,
        "internal_note": null,
        "to_invoice": false,
        "is_refund": false,
        "refunded_order_id": null,
        "customer_email": null,
        "customer_phone": null,
        "ordered_at": "2026-07-28T09:30:58.001Z",
        "client_created_at": "2026-07-28T09:28:11.000Z",
        "cancel_reason": null,
        "amount_total_client": "48.30",      // proposal only — echoed back as a warning if it disagrees
        "amount_tax_client": "8.38"
      },
      "lines": [
        { "op": "create", "uuid": "aa…", "variant_id": 901, "qty": "2", "price_unit": "12.50",
          "price_extra": "0", "price_type": "original", "discount": "0",
          "full_product_name": "Margherita", "customer_note": null, "note": "no basil",
          "combo_parent_uuid": null, "combo_id": null, "combo_item_id": null,
          "course_uuid": "c1…", "refunded_line_uuid": null, "skip_preparation": false },
        { "op": "update", "uuid": "bb…", "qty": "1" },
        { "op": "delete", "uuid": "cc…" }
      ],
      "payments": [
        { "op": "create", "uuid": "pp…", "payment_method_id": 2, "amount": "48.30",
          "is_change": false, "is_refund": false, "label": null,
          "paid_at": "2026-07-28T09:31:00.000Z", "payment_status": "done",
          "terminal": { "card_brand": "visa", "card_last4": "4242", "auth_code": "…",
                        "transaction_reference": "…", "entry_mode": "contactless" } }
      ],
      "courses": [ { "op": "create", "uuid": "c1…", "index": 1, "name": "Starters", "fired": true } ]
    }
  ]
}
```

Batch cap: 200 orders (`pos.sync.max_orders_per_batch`).

```jsonc
// 200 — always, when the envelope is well formed
{
  "server_time": "2026-07-28T09:31:02.913Z",
  "replayed": true,                          // present only on an Idempotency-Key replay
  "results": [
    {
      "uuid": "9f2c…",
      "status": "ok",                        // ok | superseded | rejected
      "server_rev": "r55123:1785255336000",
      "order": {
        "id": 55123, "uuid": "9f2c…", "name": "Bar/00412", "sequence_number": 412,
        "receipt_number": "26D02-1-000412", "ticket_code": "K7F2Q", "access_token": "b9c1…",
        "state": "paid", "pos_session_id": 881,
        "amount_untaxed": "40.0000", "amount_tax": "8.3000", "amount_total": "48.3000",
        "amount_paid": "48.3000", "amount_change": "0.0000", "amount_due": "0.0000",
        "amount_rounding": "0.0000", "updated_at": "2026-07-28 09:31:02"
      },
      "lines":    [ { "uuid": "aa…", "id": 90211, "status": "ok" } ],
      "payments": [ { "uuid": "pp…", "id": 4410, "status": "ok" } ],
      "courses":  [ { "uuid": "c1…", "id": 77, "status": "ok" } ],
      "warnings": [ { "code": "client_total_mismatch", "field": "amount_total",
                      "client": "48.30", "server": "48.31", "delta": "-0.01" } ],
      "totals": { "totalExcluded": "40.00", "totalTax": "8.30", "totalIncluded": "48.30",
                  "roundedTotal": "48.30", "roundingDelta": "0.00",
                  "taxGroups": [ { "taxGroupId": 1, "base": "40.00", "amount": "8.30" } ] }
    }
  ]
}
```

**Per-order `status`:**

| Status | Meaning | Client action |
|---|---|---|
| `ok` | Persisted; ids and authoritative amounts returned | Merge ids, `syncState = 'synced'`, store the new baseline and `server_rev` |
| `superseded` | The server already settled this order (or the draft is gone) | Discard the local mutation, adopt server state, toast loudly |
| `rejected` | Permanently invalid — see `error.code` | Quarantine; never retry blindly |

**Per-child `status`** is `ok` or `rejected` with a `code` (`unknown_variant`, `line_vanished`). A rejected *line* does not reject the order.

**Warning codes:**

| Code | Meaning |
|---|---|
| `client_total_mismatch` | The client's proposed total disagrees with the server's recomputation. Informational — a manual price override is a legitimate cause. Recorded in `sync_conflicts`. |
| `session_rerouted` | The requested session was closed; the order landed in the config's currently-open session |
| `session_rescued` | No open session existed; a **rescue session** was created and the order landed there |
| `already_settled` | Accompanies `superseded` |

**Guarantees (spec 03 §3.6):**

1. **Idempotent on `uuid`.** The unique index on `pos_orders.uuid` is the real guard; `Idempotency-Key` only saves re-doing an already-answered request (the recorded response comes back with `"replayed": true`).
2. **Per-record results.** One poisoned order never blocks the queue behind it — each order runs in its own transaction.
3. **create→update rewriting, both directions.** A `create` for a uuid the server already holds becomes an update (retry); an `update` for a uuid it has never seen becomes a create (the outbox coalesced a create and an edit). Without the reverse rewrite that line silently disappears.
4. **A closed session never loses a sale.** Orders reroute into the open session, or into a rescue session.
5. **The server recomputes every monetary field** — subtotals, tax split, order totals, `amount_paid`, `amount_change`, `amount_due`, margins — from primary facts. Line **tax ids are derived from the catalog**, not from the payload: a client cannot zero the VAT by omitting them.
6. `sequence_number` and `name` are assigned once, gaplessly per session, at the moment the order leaves `draft`.

Refunds are represented by **negative quantities**, not by a document sign flag.

---

## 5. Register — orders

### `GET /api/pos/orders`

Auth: device + `pos:sync`. Query: `state`, `from`, `to`, `search`, `cursor` (id), `limit` (1–200, default 50).

```jsonc
{ "records": [ { "id": 55123, "uuid": "9f2c…", "name": "Bar/00412", "state": "paid",
                 "amount_total": "48.3000", "updated_at": "…" } ],
  "next_cursor": 55100 | null, "total": 1284 }
```

Deliberately thin so the client can diff its cache cheaply, then hydrate only what the cashier opened.

### `GET /api/pos/orders/{order}`

Auth: device + `pos:sync`. The full graph.

```jsonc
{ "id": 55123, "uuid": "…", "name": "…", "sequence_number": 412, "receipt_number": "…",
  "tracking_number": "412", "ticket_code": "K7F2Q", "access_token": "…", "source": "pos",
  "state": "paid", "prep_state": "sent", "pos_session_id": 881, "pos_config_id": 1, "pos_device_id": 3,
  "customer_id": null, "employee_id": 17, "pricelist_id": null, "fiscal_position_id": null,
  "pos_preset_id": null, "preset_time": null, "restaurant_table_id": 12, "guest_count": 4,
  "floating_order_name": null, "is_refund": false, "refunded_order_id": null, "to_invoice": false,
  "general_customer_note": null, "internal_note": null,
  "amount_untaxed": "40.0000", "amount_tax": "8.3000", "amount_total": "48.3000",
  "amount_rounding": "0.0000", "amount_paid": "48.3000", "amount_change": "0.0000",
  "amount_due": "0.0000", "amount_discount": "0.0000",
  "tax_details": [ { "taxGroupId": 1, "base": "40.00", "amount": "8.30" } ],
  "ordered_at": "…", "paid_at": "…", "synced_at": "…", "updated_at": "…",
  "lines": [ { "id": 90211, "uuid": "aa…", "product_variant_id": 901, "product_id": 44,
               "pos_category_id": 7, "full_product_name": "Margherita", "uom_id": 1,
               "quantity": "2.000", "price_unit": "12.5000", "price_extra": "0.0000",
               "price_type": "original", "discount_percent": "0.0000", "discount_amount": "0.0000",
               "price_subtotal": "25.0000", "price_subtotal_incl": "30.2500",
               "tax_details": [ { "taxId": 1, "base": "25.00", "amount": "5.25" } ],
               "tax_signature": "1", "customer_note": null, "internal_note": [ { "text": "no basil", "color_index": 0 } ],
               "combo_parent_line_id": null, "combo_item_id": null, "restaurant_course_id": 77,
               "refunded_order_line_id": null, "refunded_quantity": "0.000", "skip_preparation": false } ],
  "payments": [ { "id": 4410, "uuid": "pp…", "payment_method_id": 2, "amount": "48.3000",
                  "is_change": false, "is_refund": false, "label": null, "paid_at": "…",
                  "payment_status": "done", "card_brand": "visa", "card_last4": "4242",
                  "auth_code": "…", "transaction_reference": "…" } ],
  "courses": [ { "id": 77, "uuid": "c1…", "course_index": 1, "name": "Starters",
                 "fired": true, "fired_at": "…", "line_count": 2 } ] }
```

Payment rows carry terminal metadata only — brand, last four, auth code. Never a PAN.

---

### Who prices a line

The server prices every register line it has a more authoritative answer for, and the client's `price_unit` is **ignored** rather than warned about (XCT-107). `client_total_mismatch` was never a control on this: it compares the client's total against a recomputation of the client's *own* prices, so a till that agrees with itself passes in silence.

The client's number stands in five cases, each for its own reason:

| Case | Why |
| -- | -- |
| open-price product (`special_kind: deposit`, or a catalogue price of 0) | the prompt *is* the price |
| special lines (tip, global discount, loyalty reward) | the amount comes from elsewhere in the system |
| `price_type: automatic` | already the output of a pricelist or reward calculation |
| `price_type: manual` | a cashier override — see below |
| a combo line the push cannot see whole | pricing a meal from a fragment reverses the meal deal |

A manual override is accepted when `pos_configs.restrict_price_control` is off (the default — price entry is then an ordinary part of the job), or when the pushing `employee_id` holds `line.price_override`, re-checked server-side. Otherwise the line is priced from the catalogue and the attempt is reported as a `price_override_refused` warning: the sale goes through at the right money and the attempt is on the record. It is **not** rejected — a rejected line is invisible to a client that reads the order's status.

`price_extra` is always the server's: it is the sum of the selected options' own extras and nothing else. On a combo child it is `0`, because `ComboCartPricer` folds the extra into the distributed price.

A refund line is priced from the line it credits. The refund cap (BAN-406) bounds how *many* units come back and says nothing about the rate.

## 6. Register — sessions & cash

### `GET /api/pos/sessions/current`

Auth: device + `pos:session`.

```jsonc
{ "session": SessionResource | null,
  // Everything the open pane needs before a session exists (REG-002, REG-004).
  "opening": { "expected_float": "135.5000",     // what the last close counted into the drawer
               "problems": [ { "code": "no_payment_method", "message": "…" } ] } }
```

`opening.problems` is empty on a register that can trade. A non-empty list is the same list
`POST /api/pos/sessions` refuses with, answered early so a cashier is not sent to count a drawer
into an open that will be rejected.

**`SessionResource`:**

```jsonc
{ "id": 881, "uuid": "…", "pos_config_id": 1,
  "name": "Bar/00001",                        // null until the opening control is confirmed
  "state": "opened",                          // opening_control | opened | closing_control | closed
  "opened_at": "…", "closed_at": null, "business_date": "2026-07-28",
  "has_cash_control": true,
  // Renamed from `cash_balance_opening` / `cash_balance_opening_expected`; the raw column names
  // never reach the client, on this path or on bootstrap.
  "opening_float": "150.0000", "expected_opening_float": "135.5000",
  "cash_balance_closing_counted": null,
  "cash_balance_closing_expected": "0.0000", "cash_difference": "0.0000",
  "cash_in_total": "0.0000", "cash_out_total": "0.0000",
  "order_count": 0, "order_amount_total": "0.0000", "refund_amount_total": "0.0000",
  "payments_total": "0.0000", "is_rescue": false, "closing_forced": false,
  "opened_by_employee_id": 17, "closed_by_employee_id": null }
```

### `POST /api/pos/sessions`

Auth: device + `pos:session`.

```jsonc
{ "opening_float": "150.00", "employee_id": 17, "notes": null,
  "denominations": [ { "denomination_value": "50.00", "quantity": 3, "pos_bill_id": 4 } ] }
```

`201` with a `SessionResource`. With cash control on the session lands in `opening_control` **without a name**; without it, straight to `opened` and numbered on the spot.

`422 session_open_failed` when the register already has an open session — that invariant is a database constraint, re-checked here so you get a domain error instead of a constraint violation.

`422 register_not_ready` when the register's configuration cannot support a session at all (REG-002). Deliberately a separate code: this one is fixed in the back office, not at the till. No session row is created.

```jsonc
{ "error": { "code": "register_not_ready", "message": "…",
             "problems": [ { "code": "no_payment_method", "message": "…" },
                           { "code": "currency_mismatch", "message": "…" },
                           { "code": "fiscal_position_unresolved", "message": "…" } ] } }
```

The whole list is returned, not the first failure, so a manager fixes everything in one trip. The
checks are: at least one active payment method owned by the register's company; the register's
currency matching the company's; and, when `use_fiscal_positions` is on, a default fiscal position
that `FiscalPosition::posLoadScope` will actually replicate to the till.

### `POST /api/pos/sessions/{session}/opening-control`

```jsonc
{ "counted_float": "150.00", "employee_id": 17 }
```

`200` with a `SessionResource` in state `opened`. **This is where the session number is minted** (REG-003) — an opening control that is abandoned never gets one, so it leaves no gap in the sequence. `422 invalid_transition` if the session was not awaiting an opening control.

### `GET /api/pos/sessions/{session}/closing-data`

Everything the closing popup needs:

```jsonc
{ "session_id": 881,
  "opening_balance": "150.0000", "cash_in": "25.0000", "cash_out": "-10.0000",
  "expected_cash": "189.2000",
  "payment_totals": [ { "payment_method_id": 2, "name": "Cash", "is_cash_count": true,
                        "ledger_code": null, "expected_amount": "24.2000",
                        "payment_count": 1, "refund_amount": "0.0000", "change_amount": "0.0000" } ],
  "order_count": 12, "draft_order_count": 1,
  "amount_authorized_diff": "0", "enforces_maximum_difference": false }
```

`expected_cash` = opening float + cash-counted payments + cash in/out movements.

An `expected_amount` can be **negative**: a payment method whose refunds outrun its takings owes the
customer, which happens as soon as someone returns with a receipt from a previous session. The
closing screen pre-fills the counted amount from it, so the counted amount is signed too.

### Money amounts on these endpoints

Every cash amount — `opening_float`, `counted_cash`, `counted_by_method.*`, `denominations.*.denomination_value`, a cash movement's `amount` — is validated as `decimal:0,4` and answers `422` otherwise. Not `numeric`: `is_numeric("1e2")` is true and `bccomp("1e2", …)` throws, so exponent notation used to reach bcmath and return `500`.

Amounts describing **physical cash** (`opening_float`, `counted_cash`, `denomination_value`) additionally reject negatives — a drawer holds no negative notes and a banknote has no negative face value. `counted_by_method.*` and a cash movement's `amount` stay signed, for the reasons above and because `cashMove` applies its own sign from the movement type.

### `POST /api/pos/sessions/{session}/close`

```jsonc
{ "counted_cash": "187.20",
  "counted_by_method": { "2": "187.20" },     // payment_method_id → counted amount
  "denominations": [ … ],
  "employee_id": 17, "notes": null,
  "manager_employee_id": 3, "manager_pin": "9999",   // required only over the variance threshold
  "force": false }
```

`200` with a `SessionResource`. On close the server freezes `session_payment_totals`, `session_sales_summaries` and `session_tax_summaries`, and writes a `difference` cash movement when the count disagrees with expectation.

`422 session_close_refused` with the current `closing_data` attached when:

- the variance exceeds `amount_authorized_diff` and `set_maximum_difference` is on, without a valid manager PIN carrying `session.close.over_variance`; **or**
- draft orders remain and `force` is not set.

With `set_maximum_difference` off, any difference closes — the number is recorded and reported, but the cashier is not held hostage by it.

### `POST /api/pos/sessions/{session}/cash-movements`

```jsonc
{ "uuid": "…", "movement_type": "cash_in", "amount": "25.00", "reason": "Change fund", "employee_id": 17 }
```

`201`: `{ "uuid": "…", "id": 5, "movement_type": "cash_in", "amount": "25.0000", "session": SessionResource }`.

The caller always sends a positive magnitude; the server signs it (`cash_out` is stored negative). `movement_type` is `cash_in` or `cash_out`.

### `GET /api/pos/sessions/{session}/cash-movements`

The drawer ledger for the closing pane (REG-012), device-scoped like every other session route.

```jsonc
{ "movements": [ { "uuid": "…", "movement_type": "cash_out",
                   "amount": "-40.0000",          // signed as stored: negative leaves the drawer
                   "reason": "Bank run",
                   "employee_id": 7, "employee_name": "Karim M.",
                   "moved_at": "…" } ] }
```

Withdrawn movements are omitted. `deleteCashMovement` soft-deletes and writes an audit row, so the record survives — but a movement that has been taken back is no longer part of the explanation of the cash in the drawer.

Deleting one (`DELETE …/cash-movements/{movement}`) needs a manager PIN verified server-side and the `cash.in_out.delete` ability; an employee id alone is not proof, because ids ship in the bootstrap payload. The session's `cash_in_total` / `cash_out_total` are recomputed, so the closing figures move with the ledger.

**Amounts.** `cash_movements.amount` reaches bcmath, so it is validated as `decimal:0,4` on **both** ways in — the `POST` endpoint and the `session.cash_move` sync command, whose generic `commands[]` payload carries no schema of its own. The check lives in `SessionService::cashMove`, the one thing both routes pass through.

### `POST /api/pos/sessions/{session}/accounting-export`

`201`: `{ "uuid": "…", "state": "generated", "total_sales": "…", "total_tax": "…", "total_payments": "…", "imbalance_amount": "0.0000" }`.

Reads the **frozen** summaries, never the live orders — an exported period must re-export byte-identically. `imbalance_amount` is `sales + tax − payments`; anything non-zero is surfaced rather than rounded away.

---

## 7. Register — restaurant

### `GET /api/pos/floors`

Auth: device + `pos:restaurant`.

```jsonc
{ "floors": [ { "id": 1, "uuid": "…", "name": "Terrace", "background_color": null, "sequence": 1,
                "tables": [ { "id": 4, "uuid": "…", "table_number": 1, "name": "T1",
                              "identifier": "a1b2c3d4",       // the QR capability token
                              "shape": "square", "position_x": "10.00", "position_y": "10.00",
                              "width": "50.00", "height": "50.00", "seats": 4, "color": null,
                              "parent_id": null } ] } ] }
```

### Floor & table CRUD

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/pos/floors` | `{name, background_color?, sequence?, active?}` | `201 {floor}` |
| `PATCH` | `/api/pos/floors/{floor}` | same | `200 {floor}` |
| `DELETE` | `/api/pos/floors/{floor}` | — | `204` |
| `POST` | `/api/pos/tables` | `{restaurant_floor_id, table_number, name?, shape?, position_x?, position_y?, width?, height?, seats?, color?, parent_id?}` | `201 {table}` |
| `PATCH` | `/api/pos/tables/{table}` | same | `200 {table}` |
| `DELETE` | `/api/pos/tables/{table}` | — | `204` |

Setting `parent_id` links the table to a parent: the child's open order merges into the parent's, and cycles are refused with `422 invalid_link`.

### `POST /api/pos/orders/{order}/transfer`

```jsonc
{ "table_id": 12, "employee_id": 17 }
```

```jsonc
{ "order": OrderResource, "merged": true, "merge_id": 9 }
```

If the target table already holds a draft order the two are **merged** (`merged: true`) and the returned order is the *target*. A self-transfer is `422 transfer_refused`.

### `POST /api/pos/orders/{order}/merge`

```jsonc
{ "target_order_uuid": "…", "employee_id": 17 }
```

`{ "order": OrderResource, "merge_id": 9 }`. Guest counts add up, courses are matched by index, lines move, the source order is deleted — and the kitchen's "already sent" snapshot moves with the lines, so no ticket is re-fired.

### `POST /api/pos/order-merges/{merge}/unmerge`

`{ "order": OrderResource }` — a new draft order on the original table, restored from the merge's snapshot. A second unmerge of the same record is `422 unmerge_refused`.

### `PATCH /api/pos/orders/{order}/guests`

`{ "guest_count": 4 }` → `{ "order": OrderResource }`.

### Courses

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/pos/orders/{order}/courses` | — | `{ "courses": [CourseResource] }` |
| `POST` | `/api/pos/orders/{order}/courses` | `{uuid?, course_index?, name?}` | `201 CourseResource` |
| `POST` | `/api/pos/orders/{order}/courses/{course}/fire` | `{snapshot_version?, employee_id?}` | see below |
| `DELETE` | `/api/pos/orders/{order}/courses/{course}` | — | `204`, or `422` if already fired |

**`CourseResource`**: `{ id, uuid, pos_order_id, course_index, name, fired, fired_at, line_count }`.

Fire response:

```jsonc
{ "course": CourseResource, "delta": PreparationDelta, "prep_orders": [ Ticket ], "print_jobs": [12], "snapshot_version": 3 }
```

`409 order_outdated` (with the current `delta`) when another device already fired past this client's `snapshot_version`.

---

## 8. Register — kitchen delta

### `GET /api/pos/orders/{order}/preparation-changes`

The authoritative answer to "what has the kitchen not yet seen". The client keeps its own copy for the offline badge, but this is the arbiter — it is what stops two waiters double-firing a table.

**`PreparationDelta`:**

```jsonc
{
  "order_uuid": "9f2c…",
  "changes": [
    { "line_uuid": "aa…", "line_id": 90211, "product_id": 44, "pos_category_id": 7,
      "name": "Margherita", "quantity": "2.000",
      "change_type": "new",                     // new | cancelled | note_update | fire_course
      "customer_note": null, "internal_note": "no basil",
      "course_id": 77, "course_index": 1, "combo_parent_uuid": null }
  ],
  "nbr_of_changes": 2,                          // absolute — what the badge shows
  "count": "2.000",                             // signed — net effect on the kitchen
  "order_note_changed": false,
  "general_customer_note": null,
  "internal_note": null,
  "snapshot_version": 1,
  "snapshot_at": "2026-07-28 09:31:02.913"
}
```

`quantity` is signed: positive is work to do, negative is work to undo. A cancellation of something already cooked is visible, not silently dropped.

### `POST /api/pos/orders/{order}/preparation`

```jsonc
{ "course_index": null, "snapshot_version": 1, "employee_id": 17 }
```

```jsonc
{ "delta": PreparationDelta, "prep_orders": [ Ticket ], "print_jobs": [12, 13], "snapshot_version": 2 }
```

Send `snapshot_version` — the value from the last delta you rendered. If the server has moved past it, another till already fired the order and you get `409 order_outdated` with the server's current delta: adopt it, do **not** print.

**`Ticket`** (also the `KitchenTicketCreated` broadcast payload):

```jsonc
{ "prep_order_id": 5, "prep_order_uuid": "…", "prep_display_id": 2, "order_uuid": "9f2c…",
  "tracking_number": "412", "table_label": "T1", "guest_count": 4,
  "fired_at": "2026-07-28T09:31:02.913Z",
  "lines": [ { "id": 33, "line_uuid": "aa…", "line_id": 90211, "product_id": 44,
               "pos_category_id": 7, "name": "Margherita", "quantity": "2.000",
               "change_type": "new", "customer_note": null, "internal_note": "no basil",
               "course_id": 77, "course_index": 1, "combo_parent_uuid": null } ] }
```

### `POST /api/pos/orders/{order}/preparation/mark-sent`

`{ "snapshot_version": 2 }`. Rebuilds the snapshot to "everything already sent" **without printing** — used after a self-order submission so the cashier does not re-fire the customer's lines.

---

## 9. Kitchen display

All endpoints: auth device + `pos:kitchen`. `{display}` is the display's `access_token`. A display token may only address screens wired to its own config; anything else is `404`.

### `GET /api/kitchen/{display}/orders`

Query: `since` (optional).

```jsonc
{
  "server_time": "…",
  "display": { "id": 2, "name": "Pass", "layout": "columns",
               "average_prep_minutes": 10, "late_threshold_minutes": 15,
               "done_retention_minutes": 60, "sound_on_new_order": true },
  "stages": [ { "id": 1, "prep_display_id": 2, "name": "To do", "stage_type": "todo",
                "color": null, "alert_after_minutes": null, "sequence": 10, "is_default": true } ],
  "orders": [ { "id": 5, "uuid": "…", "prep_display_id": 2, "pos_order_id": 55123,
                "tracking_number": "412", "table_label": "T1", "guest_count": 4,
                "preset_label": null, "customer_name": null, "order_note": null,
                "state": "pending",             // pending | in_progress | ready | served | cancelled
                "fired_at": "…", "first_started_at": null, "ready_at": null, "served_at": null,
                "is_recalled": false, "age_seconds": 92,
                "lines": [ { "id": 33, "uuid": "…", "pos_order_line_uuid": "aa…",
                             "prep_stage_id": 1, "course_index": 1, "product_id": 44,
                             "display_name": "Margherita", "quantity": "2.000",
                             "change_type": "new", "customer_note": null, "internal_note": "no basil",
                             "state": "todo",   // todo | in_progress | ready | served | cancelled
                             "started_at": null, "ready_at": null, "served_at": null, "fired_at": "…" } ] } ]
}
```

The board is reachable by polling as well as by websocket. A kitchen that silently misses orders is far worse than one that knows it is blind, so the socket is an optimisation, never the contract. No prices, no customers, no payments — a kitchen screen is a shared device in a room strangers walk through.

### `GET /api/kitchen/{display}/stages`

`{ "stages": [ … ] }`.

### `POST /api/kitchen/{display}/orders/{prepOrder}/stage`

`{ "stage_id": 2, "employee_id": null }` — bump the whole card. Every line follows.

```jsonc
{ "prep_order_id": 5, "state": "in_progress", "lines": [ … ] }
```

`422 invalid_stage` when the stage belongs to another display.

### `POST /api/kitchen/{display}/lines/{line}/state`

`{ "state": "ready", "employee_id": null }` — per-item done. Same response shape; the card state is the aggregate of its lines.

### `POST /api/kitchen/{display}/orders/{prepOrder}/recall`

`{ "employee_id": null }`. Returns the card to `pending` and sets `is_recalled`. Every transition, including recalls, is written to `prep_line_stage_logs`.

### `GET /api/kitchen/print-jobs`

Auth: device + `pos:print`. Query: `printer_id`, `limit` (default 20).

```jsonc
{ "jobs": [ { "id": 12, "uuid": "…", "pos_printer_id": 1, "pos_order_id": 55123,
              "job_type": "prep_new",          // prep_new | prep_cancelled | prep_note_update | prep_fire_course | bill | receipt | tip_slip | cash_report | test
              "payload": { … }, "rendered_text": "        KITCHEN PRINTER\n=====…",
              "copies": 1, "state": "queued", "attempts": 0, "last_error": null,
              "queued_at": "…", "printed_at": null } ],
  "server_time": "…" }
```

Printers are **polled**, not pushed: a LAN thermal printer behind a station agent cannot hold a websocket, and Chrome's private-network rules make direct browser→printer calls unreliable. `rendered_text` is fixed-width plain text ready for an ESC/POS `TEXT` block; `payload` is the document IR if you want to render it yourself.

### `POST /api/kitchen/print-jobs/{job}/ack`

`{ "state": "printed" | "failed" | "skipped", "error": null }` → `204`. Acknowledge per job so a retry never re-prints the ones that already succeeded.

---

## 10. Self-order (public)

Base path `/api/self-order/{configToken}`. Auth: the config token in the path (or `?t=`). Optional `?tt={tableToken}`. Throttled per IP **and** per config.

Failure codes: `403 invalid_config_token`, `403 invalid_table_token`, `404 self_order_disabled`, `403 invalid_order_token`.

A table token resolves through physical merges to the parent table, so a QR on a linked table lands the cart on the parent's tab.

### `GET /api/self-order/{configToken}/menu`

The same envelope as `/api/pos/bootstrap` with `"profile": "self_order"`, restricted to the menu-facing entities, plus:

```jsonc
{
  "self_order": {
    "mode": "mobile",                    // nothing | consultation | mobile | kiosk
    "service_mode": "table",             // counter | table
    "pay_after": "meal",                 // each | meal
    "ordering_open": true,
    "brand_name": "Trattoria",
    "primary_color": "#8B1E1E", "text_color": "#FFFFFF",
    "kiosk_idle_seconds": 90, "kiosk_confirmation_seconds": 30,
    "online_payment_method_id": 4,
    "custom_links": [ { "id": 1, "name": "Allergens", "url": "https://…", "style": "primary", "open_in_new_tab": true } ]
  },
  "table": { "id": 4, "name": "T1", "table_number": 1, "seats": 4 } | null
}
```

Never present in this profile: `employees`, `pos_devices`, `pos_bills`, `pos_notes`, `pos_printers`, costs, margins, internal notes, or any other table's QR identifier.

### `POST /api/self-order/{configToken}/orders`

```jsonc
{
  "order_uuid": "…",                     // optional; the client may mint its own
  "preset_id": null,
  "customer_note": "Table by the window",
  "customer_email": null, "customer_phone": null,
  "table_stand_number": "17",
  "lines": [ { "variant_id": 901, "quantity": 2, "customer_note": null,
               "attribute_value_ids": [], "combo_parent_uuid": null, "combo_item_id": null } ]
}
```

**Note what is absent: prices.** The cart may not propose them. The server resolves every line price from the catalog and the applicable pricelist; a payload that sends `price_unit` anyway has it ignored *and* recorded as a `price_tamper` conflict.

```jsonc
// 201
{ "order": SelfOrderStatus, "appended": true, "access_token": "b9c1…", "warnings": [] }
```

**`appended`** is decided by the *config*, never by the client: in table service with `pay_after = meal` the cart joins the table's existing draft order so the tab stays whole. Everywhere else it starts its own order — and in counter/kiosk service the order is not attached to a table at all, because the schema allows one draft order per table.

Store `access_token`: it is the only credential for the order's own endpoints.

`422 cart_rejected` for an empty cart, a venue with ordering disabled, or an unknown variant.

### `GET /api/self-order/{configToken}/orders/{orderUuid}`

Header `X-Order-Token: {access_token}`.

**`SelfOrderStatus`:**

```jsonc
{ "uuid": "…", "access_token": "…", "state": "draft", "prep_state": "sent",
  "tracking_number": "S412", "table_stand_number": "17",
  "amount_untaxed": "20.0000", "amount_tax": "4.2000", "amount_total": "24.2000",
  "amount_paid": "0.0000", "amount_due": "24.2000",
  "lines": [ { "uuid": "…", "full_product_name": "Margherita", "quantity": "2.000",
               "price_unit": "10.0000", "price_subtotal_incl": "24.2000", "customer_note": null } ],
  "server_time": "…" }
```

### `POST /api/self-order/{configToken}/orders/{orderUuid}/cancel`

Header `X-Order-Token`. `200 SelfOrderStatus` in state `cancelled`; `422 cancel_refused` once the order has left `draft`.

### `POST /api/self-order/{configToken}/orders/{orderUuid}/payment-intent`

Header `X-Order-Token`. Body `{ "return_url": "https://…" }` (optional).

```jsonc
// 201
{ "reference": "SO-A1B2C3D4E5", "provider_reference": "null_…", "state": "pending",
  "redirect_url": "https://…" | null, "amount": "24.2000" }
```

`422 payment_intent_failed` when the venue has no online payment method or the method has no provider.

### `POST /api/self-order/{configToken}/orders/{orderUuid}/payment-confirm`

Header `X-Order-Token`. Body `{ "reference": "SO-A1B2C3D4E5", "payload": { … } }`.

```jsonc
{ "state": "done", "order": SelfOrderStatus }
```

Idempotent on the transaction reference. On capture the server writes the `pos_payments` row, recomputes the totals and flips the order to `paid` when nothing is due.

> **Provider status.** The shipped `PaymentProvider` implementation is `NullProvider`: it records intents and confirms them without contacting anyone. The *flow* is real end to end — `payment_transactions`, `pos_payments`, recomputation, the `payment.status` broadcast. Swapping in a PSP is one container binding and does not change this contract. `NullProvider::verifyWebhook()` returns `false` by design; an unsigned webhook must never be able to move money, so no webhook route is exposed.

---

## 11. Realtime (Reverb)

Reverb carries **change notifications and small state deltas**. It is explicitly not the sync transport: every event has a REST fallback that produces the same result, and the client is correct — just slower — with websockets permanently down.

### 11.1 Connecting

```ts
const echo = new Echo({
  broadcaster: 'reverb',
  key: import.meta.env.VITE_REVERB_APP_KEY,
  wsHost: import.meta.env.VITE_REVERB_HOST,
  wsPort: Number(import.meta.env.VITE_REVERB_PORT),
  forceTLS: import.meta.env.VITE_REVERB_SCHEME === 'https',
  authEndpoint: '/broadcasting/auth',
  auth: { headers: { Authorization: `Bearer ${deviceToken}` } },
});
```

The broadcasting auth endpoint authenticates the **device** token, not a session cookie.

### 11.2 Channels

| Channel | Type | Who | Carries |
|---|---|---|---|
| `pos.config.{configToken}` | private | registers + displays of one register | `order.synced`, `order.state`, `table.state`, `session.closed`, `catalog.changed`, `kitchen.ticket.*`, `payment.status`, `selforder.placed` |
| `pos.config.{configToken}.devices` | presence | registers of one config | who is online |
| `pos.session.{sessionId}` | private | same | `session.closed` |
| `pos.device.{deviceUuid}` | private | one device | targeted commands |
| `pos.table.{tableId}` | private | registers | `table.state` |
| `kitchen.display.{displayToken}` | private | one KDS screen | `kitchen.ticket.created`, `kitchen.ticket.updated` |
| `pos.self.{configToken}` | **public** | anonymous self-order clients | `catalog.changed` |
| `pos.order.{orderAccessToken}` | **public** | one customer's phone | `order.state`, `payment.status`, `selforder.placed` |

`configToken` is `pos_configs.access_token`; `displayToken` is `prep_displays.access_token`; `orderAccessToken` is `pos_orders.access_token`.

The two public channels are deliberate: **the channel name is the capability**. Knowing `pos.order.{token}` is knowing the secret, which is exactly the property we want for an anonymous customer with no account. Nothing sensitive — costs, margins, other orders — is ever emitted on them.

### 11.3 Events

Every payload carries `v` (payload version). Events that originate from a device carry `emitted_by_device_uuid` so the originator can ignore its own echo.

| `broadcastAs` | Channels | Payload |
|---|---|---|
| `order.synced` | config | `{v, order_uuid, order_id, state, table_id, amount_total, updated_at, emitted_by_device_uuid}` |
| `order.state` | config, `pos.order.{token}` | `{v, order_uuid, order_id, from_state, to_state, tracking_number, emitted_by_device_uuid}` |
| `table.state` | config, table | `{v, table_id, occupied, order_count, guest_count, amount_total, order_uuid, child_table_ids, emitted_by_device_uuid}` |
| `kitchen.ticket.created` | display, config | `{v, ticket}` — the full `Ticket` from §8 |
| `kitchen.ticket.updated` | display, config | `{v, prep_order_id, prep_order_uuid, state, lines: [{id, uuid, pos_order_line_uuid, state}], recalled}` |
| `payment.status` | config, `pos.order.{token}` | `{v, order_uuid, payment_uuid, status, amount, terminal}` |
| `session.closed` | config, session | `{v, session_id, state, cash_difference, totals, emitted_by_device_uuid}` |
| `catalog.changed` | config, `pos.self.{token}` | `{v, models: ["products"], product_ids, available, since}` |
| `selforder.placed` | config, `pos.order.{token}` | `{v, order_uuid, order_id, state, table_id, tracking_number, amount_total, source, appended}` |

Events are **thin** by design — an id and enough context to decide whether to pull. A fat event is a second, unversioned, untested serialisation path; a thin event is a cache-invalidation hint. `kitchen.ticket.created` is the one exception: a kitchen ticket must appear instantly and the KDS is a display, not a source of truth.

`catalog.changed` is coalesced in a queued job: a bulk price import produces one event per config, not forty thousand.

**On reconnect always do three things** — drain the outbox, `GET /api/pos/delta?since=…`, and `GET /api/pos/open-orders?since=…`. Websockets guarantee nothing about messages sent while disconnected.

---

## 12. Back-office (Inertia)

Session auth (`web` guard). Page components live at `resources/js/backoffice/pages/{Name}.tsx` — the strings below are exactly what `Inertia::render()` is called with.

Shared props on every page (from `HandleInertiaRequests`):

```jsonc
{ "auth": { "user": { "id": 1, "name": "…", "email": "…" }, "abilities": ["…"] } | null,
  "flash": { "success": "…" | null, "error": "…" | null } }
```

Props marked **deferred** arrive in a follow-up request (Inertia v2 `Inertia::defer`) — render a skeleton for them.

| Page component | Route | Props |
|---|---|---|
| `Auth/Login` | `GET /login` | `canResetPassword` |
| `Dashboard/Index` | `GET /` | `registers[]` `{id, name, is_restaurant, self_ordering_mode, device_count, session: {id, name, state, opened_at, order_count, order_amount_total}\|null}`; **deferred** `today` `{order_count, revenue, open_sessions}`; **deferred** `rescueSessions[]` |
| `PosConfigs/Index` | `GET /pos-configs` | `configs[]` `{id, name, active, is_restaurant, self_ordering_mode, currency_id, config_revision}` |
| `PosConfigs/Edit` | `GET /pos-configs/{config}/edit` | `config` (every column + `access_token` + `payment_method_ids`, `pricelist_ids`, `fiscal_position_ids`, `preset_ids`, `printer_ids`, `limited_category_ids`, `employee_ids`, `floor_ids`, `prep_display_ids`); **deferred** `options` `{payment_methods, pricelists, fiscal_positions, presets, printers, categories, employees}`; **deferred** `devices[]` |
| `Products/Index` | `GET /products` | `products` (Laravel paginator of `{id, name, default_code, barcode, list_price, standard_price, available_in_pos, self_order_available, active, categories[]}`); `filters` `{search, category_id}`; **deferred** `categories[]` |
| `Products/Edit` | `GET /products/{product}/edit` | `product` (columns + `pos_category_ids`, `tax_ids`, `variants[]`); **deferred** `options` `{categories, taxes}` |
| `Categories/Index` | `GET /categories` | `categories[]` `{id, name, parent_id, depth, sequence, color, hour_after, hour_until, self_order_visible, active}` |
| `Pricelists/Index` | `GET /pricelists` | `pricelists[]` `{id, name, currency_id, sequence, active, item_count}` |
| `Pricelists/Edit` | `GET /pricelists/{pricelist}/edit` | `pricelist`; `items[]` (every `pricelist_items` column) |
| `Taxes/Index` | `GET /taxes` | `taxes[]` `{id, name, description, tax_group_id, amount_type, amount, price_include, include_base_amount, is_base_affected, has_negative_factor, sequence, rounding_strategy, active}`; `groups[]` |
| `PaymentMethods/Index` | `GET /payment-methods` | `methods[]` `{id, name, method_type, is_cash_count, currency_id, identify_customer, allow_change, allow_refund, is_rounding_target, terminal_provider, payment_provider_id, ledger_code, sequence, active}`; `providers[]` |
| `Employees/Index` | `GET /employees` | `employees[]` `{id, name, job_title, default_role, color, has_pin, has_badge, user_id, active}`; `roles[]` `{value, label}`; `abilities` (role → ability list) |
| `Floors/Index` | `GET /floors` | `floors[]` `{id, uuid, name, background_color, sequence, table_count, active}` |
| `Floors/Edit` | `GET /floors/{floor}/edit` | `floor`; `tables[]` (every `restaurant_tables` column) |
| `Orders/Index` | `GET /orders` | `orders` (paginator of `{id, uuid, name, receipt_number, state, source, ordered_at, amount_total, pos_session_id, is_refund}`); `filters`; `states[]` |
| `Orders/Show` | `GET /orders/{order}` | `order`; `lines[]`; `payments[]`; `courses[]`; `can` `{void, refund}` |
| `Sessions/Index` | `GET /sessions` | `sessions` (paginator of `{id, name, pos_config_id, state, business_date, opened_at, closed_at, order_count, order_amount_total, cash_difference, is_rescue, closing_forced}`); `filters`; `states[]` |
| `Sessions/Show` | `GET /sessions/{session}` | `session`; `paymentTotals[]`; **deferred** `salesSummaries[]`, `taxSummaries[]`, `cashMovements[]`; `closingData\|null`; `can` `{close}` |
| `Reports/SalesDetails` | `GET /reports/sales-details` | `filters` `{from, to, config_id}`; `byProduct[]`; `byCategory[]`; `byTax[]`; `byPaymentMethod[]` |
| `Reports/SessionReport` | `GET /reports/session?session_id=` | `session`; `paymentTotals[]`; `salesSummaries[]`; `taxSummaries[]`; `cashMovements[]` |
| `Reports/OrderAnalytics` | `GET /reports/order-analytics` | `filters`; `totals` `{order_count, revenue, refund_count, guests}`; `bySource[]`; `byDay[]` |
| `Printers/Index` | `GET /printers` | `printers[]` `{…, category_ids[]}`; `categories[]`; **deferred** `queue[]` |
| `PrepDisplays/Index` | `GET /prep-displays` | `displays[]` `{id, uuid, name, layout, average_prep_minutes, late_threshold_minutes, done_retention_minutes, show_all_categories, sound_on_new_order, active}` |
| `PrepDisplays/Edit` | `GET /prep-displays/{prepDisplay}/edit` | `display`; `stages[]`; `categoryIds[]`; `categories[]` |
| `SelfOrder/Settings` | `GET /self-order/{config}/settings` | `config` (self-order fields + `access_token` + `custom_link_ids`); `modes[]`; `serviceModes[]`; `payAfterModes[]`; `customLinks[]`; `paymentMethods[]` |
| `Devices/Index` | `GET /devices` | `devices[]` `{id, uuid, name, device_identifier, device_type, pos_config_id, pos_config_name, last_seen_at, last_synced_at, user_agent, active}`; `configs[]` |

### 12.1 Back-office writes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/login` | `{email, password, remember}`; throttled 10/min |
| `POST` | `/logout` | |
| `PATCH` | `/pos-configs/{config}` | Any settings group + the pivot arrays. **Bumps `config_revision`**, which is what tells every register to discard its cache |
| `POST` | `/pos-configs/{config}/pairing-codes` | `{device_type, name?}` → `201 {code, expires_at, ttl_seconds}` (JSON, not a redirect) |
| `PATCH` | `/products/{product}` | incl. `pos_category_ids`, `tax_ids` |
| `POST`/`PATCH`/`DELETE` | `/categories`, `/categories/{category}` | |
| `PATCH` | `/pricelists/{pricelist}` · `/taxes/{tax}` · `/payment-methods/{paymentMethod}` | |
| `PATCH` | `/employees/{employee}` | `pin` and `badge` are **write-only**; the server stores `sha256(value)` and the list only ever reports `has_pin` / `has_badge` |
| `PATCH` | `/floors/{floor}` | |
| `POST` | `/tables/{table}/rotate-token` | Invalidates that table's printed QR |
| `POST` | `/sessions/{session}/close` | Manager only; always forced |
| `POST` | `/accounting-exports` | `{period_start, period_end, session_ids?}` |
| `PATCH` | `/printers/{printer}` | incl. `category_ids` |
| `POST` | `/printers/{printer}/test` | `{pos_config_id}` — queues a real ticket; the only meaningful test of a printer is paper |
| `PATCH` | `/prep-displays/{prepDisplay}` | incl. `category_ids` |
| `PATCH` | `/self-order/{config}/settings` | Bumps `config_revision` |
| `POST` | `/self-order/{config}/rotate-token` | **Invalidates every printed QR for the venue** |
| `DELETE` | `/devices/{device}` | Revokes tokens immediately. An offline revoked till keeps working until it reconnects — unavoidable and correct; its queued orders arrive quarantined rather than lost |

---

## 13. PWA shells

Propless Blade documents, byte-identical for every user and tenant so a service worker can precache them.

| URL | Blade view | Vite entry |
|---|---|---|
| `/pos/{config}/{any?}` | `resources/views/register.blade.php` | `resources/js/register/main.tsx` |
| `/pos/{config}/display` | `resources/views/customer_display.blade.php` | `resources/js/register/customer-display.tsx` |
| `/kitchen/{display}/{any?}` | `resources/views/kitchen.blade.php` | `resources/js/kitchen/main.tsx` |
| `/menu/{token}/{any?}` | `resources/views/selforder.blade.php` | `resources/js/selforder/main.tsx` |
| `/` (auth) | `resources/views/app.blade.php` | `resources/js/backoffice/app.tsx` |

The path segment is a hint for the client router only — it is never trusted. The register learns its config from its **device token**, and the self-order client from the config token it sends to the API.

---

## 14. Endpoint index

52 JSON endpoints, 57 web routes.

```
POST   /api/devices/pair
GET    /api/devices/me
DELETE /api/devices/me
GET    /api/ping

GET    /api/pos/bootstrap/manifest
GET    /api/pos/bootstrap
GET    /api/pos/delta
GET    /api/pos/open-orders
GET    /api/pos/products
GET    /api/pos/customers
POST   /api/pos/employees/verify
POST   /api/pos/sync
GET    /api/pos/orders
GET    /api/pos/orders/{order}

GET    /api/pos/sessions/current
POST   /api/pos/sessions
POST   /api/pos/sessions/{session}/opening-control
GET    /api/pos/sessions/{session}/closing-data
POST   /api/pos/sessions/{session}/close
POST   /api/pos/sessions/{session}/cash-movements
POST   /api/pos/sessions/{session}/accounting-export

GET    /api/pos/floors
POST   /api/pos/floors
PATCH  /api/pos/floors/{floor}
DELETE /api/pos/floors/{floor}
POST   /api/pos/tables
PATCH  /api/pos/tables/{table}
DELETE /api/pos/tables/{table}
POST   /api/pos/orders/{order}/transfer
POST   /api/pos/orders/{order}/merge
POST   /api/pos/order-merges/{merge}/unmerge
PATCH  /api/pos/orders/{order}/guests
GET    /api/pos/orders/{order}/courses
POST   /api/pos/orders/{order}/courses
POST   /api/pos/orders/{order}/courses/{course}/fire
DELETE /api/pos/orders/{order}/courses/{course}

GET    /api/pos/orders/{order}/preparation-changes
POST   /api/pos/orders/{order}/preparation
POST   /api/pos/orders/{order}/preparation/mark-sent

GET    /api/kitchen/{display}/orders
GET    /api/kitchen/{display}/stages
POST   /api/kitchen/{display}/orders/{prepOrder}/stage
POST   /api/kitchen/{display}/orders/{prepOrder}/recall
POST   /api/kitchen/{display}/lines/{line}/state
GET    /api/kitchen/print-jobs
POST   /api/kitchen/print-jobs/{job}/ack

GET    /api/self-order/{configToken}/menu
POST   /api/self-order/{configToken}/orders
GET    /api/self-order/{configToken}/orders/{orderUuid}
POST   /api/self-order/{configToken}/orders/{orderUuid}/cancel
POST   /api/self-order/{configToken}/orders/{orderUuid}/payment-intent
POST   /api/self-order/{configToken}/orders/{orderUuid}/payment-confirm
```

---

## 15. Not yet implemented

Endpoints the front-ends should **not** expect. Each is a deliberate gap, not an oversight.

| Area | Status |
|---|---|
| Refund creation endpoint | Refunds sync as ordinary orders with negative quantities and `is_refund`/`refunded_order_id`. The refundable-quantity cap (spec 03 §3.7) **is** enforced as of BAN-406: every negative line must name the line it refunds (`refunded_line_uuid`), the total is capped under a row lock on the original line and re-checked after the write, and a refund may reference exactly one original order. Rejections come back at **order** level — `refund_unlinked`, `refund_exceeds_sold`, `refund_spans_orders` — because a per-line rejection is invisible to the client, which reads the order's status, applies the ack and retires the outbox entry. |
| Invoicing (`pos_invoices`) | No endpoint. `to_invoice` is stored and ignored. |
| Loyalty | No endpoint. `enable_loyalty` is stored and ignored. |
| Split bill | No dedicated endpoint; a split is two synced orders today. `enable_split_bill` is only a capability flag. |
| Tips (RST-120…129) | `tip_amount` / `is_tipped` are stored; no tip-adjustment endpoint. |
| Customer create/update from the register | Read-only (`GET /api/pos/customers`). |
| Product info popup, barcode lookup | Not implemented; use `GET /api/pos/products?search=`. |
| Preset time slots | Not implemented. |
| Receipt email/SMS, portal | Not implemented. |
| Payment webhooks | Deliberately absent — `NullProvider::verifyWebhook()` returns `false` and an unsigned webhook must never move money. |
| `/broadcasting/auth` for public channels | Not needed; public channels have no auth callback. |
