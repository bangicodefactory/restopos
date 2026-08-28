# spec-01 — Relational Database Schema (Laravel 12 restaurant POS)

Target: a **standalone restaurant POS product** rewritten on Laravel 12 + MySQL 8 / PostgreSQL 15,
with full functional parity to Odoo 19 `point_of_sale` + `pos_restaurant` + `pos_self_order` +
`pos_online_payment` + `pos_hr` + `pos_discount` + `pos_loyalty` + `pos_sms`, **minus** Odoo's
generic ERP depth (double-entry accounting, stock/inventory valuation, procurement, MRP, portal,
website, mail-framework chatter).

Source inventories this spec is derived from:
`analysis/01-pos-backend.md`, `analysis/03-pos-restaurant.md`, `analysis/04-self-order.md`,
`analysis/05-backoffice-aux.md`.

---

## 0. Conventions (apply to EVERY table unless stated otherwise)

### 0.1 Naming
- snake_case, **plural** table names (`pos_orders`, `restaurant_tables`).
- Pivot tables: singular models in alphabetical order (`pos_category_product`), **except** where a
  pivot carries payload/ordering — then it gets a plural domain name (`pos_config_employee` is kept
  singular-alphabetical by Laravel convention even though it carries `access_level`).
- FK columns: `<singular_table>_id` (`pos_config_id`, `product_variant_id`).
- Boolean columns: `is_*`, `has_*`, `can_*`, `allow_*`, or a bare adjective (`active`, `fired`).

### 0.2 Standard columns
| Column | Type | Applied to |
|---|---|---|
| `id` | `$table->id()` (bigIncrements, unsigned) | every table (incl. pivots that carry payload) |
| `uuid` | `char(36)` **unique** | every **client-created / offline-syncable** record (orders, lines, payments, courses, cash movements, prep records, loyalty point claims). Generated client-side (UUIDv4/v7), never re-issued by the server. This is the idempotency key. |
| `created_at`,`updated_at` | `timestamps()` (`timestamp` nullable, precision 3) | every table. `updated_at` is the **sync watermark** (`?since=` incremental loads) → always indexed on syncable tables. |
| `deleted_at` | `softDeletes()` | only where a hard delete must still be replayable to clients (`pos_orders`, `pos_order_lines`, `pos_payments`, `restaurant_order_courses`, `restaurant_tables`, `restaurant_floors`). Everything else uses `active`. |
| `active` | `boolean default true, index` | archivable master data (Odoo's `active`). Clients receive `active=false` rows so they can purge locally (replaces `_unrelevant_records` / `filter_local_data`). |
| `company_id` | `foreignId nullable/required` | all tenant-scoped tables (see 0.6). |
| `sequence` | `integer default 10, index` | user-orderable master data. |

### 0.3 Numeric types (money must match to the cent — no floats anywhere)
| Concept | Laravel type | Rationale |
|---|---|---|
| Monetary amount | `decimal(16, 4)` | 4 dp headroom for tax-included back-computation and 3-dp currencies (KWD/BHD/TND). Rounded to `currencies.decimal_places` at persistence boundaries. |
| Unit price | `decimal(16, 4)` | |
| Quantity | `decimal(16, 3)` | weighed products (scale) need 3 dp. |
| Percentage (discount, tax rate) | `decimal(9, 4)` | e.g. `19.0000`, `33.3333`. |
| Currency rate | `decimal(24, 12)` | |
| Rounding step / precision | `decimal(12, 6)` | |
| Points (loyalty) | `decimal(16, 3)` | |
| Geometry (floor plan px) | `decimal(10, 2)` | |
| Hour-of-day (0–24 float) | `decimal(5, 2)` | Odoo `hour_until`/`hour_from`. |

### 0.4 Enums
Declared as `$table->string('col', N)` + a DB `CHECK` constraint (portable, cheap to extend) and a
PHP backed enum cast. Full value lists in **§4**. `enum()` in the column tables below means exactly
this pattern.

### 0.5 JSON columns
Used only for (a) opaque device/terminal payloads, (b) denormalised snapshots that must be frozen
in time, (c) client UI state that never needs to be queried. Never for anything filtered or joined.
All JSON columns are `json` (Postgres `jsonb` recommended: `$table->jsonb()`).

### 0.6 Multi-tenancy / scoping
Single `companies` table (a POS group can run several legal entities / brands). Every catalog,
config, order and money table carries `company_id` with a global Eloquent scope. Cross-company FKs
are forbidden by app-level validation. If the deployment is single-company, `company_id` is still
present and always `1` — it costs nothing and prevents a painful retrofit.

### 0.7 Foreign key policy
| Relationship kind | `onDelete` |
|---|---|
| Child rows of an aggregate root (order → lines/payments/courses) | `cascade` |
| Reference to master data used in historical documents (order line → product) | `restrict` |
| Optional soft reference (order line → course, order → table) | `set null` (`nullOnDelete()`) |
| Pivot rows | `cascade` on both sides |
| Config/lookup references that must never dangle (payment_method → journal-ish) | `restrict` |

### 0.8 What was globally dropped from Odoo (and why)
| Odoo concept | Decision |
|---|---|
| `account.move` / `account.move.line` / `account.journal` / `account.account` / `account.payment` / `account.bank.statement(.line)` (double-entry engine) | **Dropped.** Replaced by `cash_movements` + `session_payment_totals` + `session_sales_summaries` + `session_tax_summaries` + `accounting_exports` (§ Session/Cash). Enough to produce a per-session accounting export (sales by tax/category/product, payments by method, cash over/short, invoices issued) for an external ledger; no journal items, no reconciliation, no lock dates. |
| `stock.*` (picking, move, quant, lot, warehouse, route, reference), `pos.pack.operation.lot`, ship-later | **Dropped.** A restaurant POS does not run WMS. Kept: an optional `products.track_stock` + `product_variants.on_hand_qty` denormalised counter and `stock_adjustments` (out of scope for v1 — noted, not tabled). Lot/serial capture, pickings, `failed_pickings`, `update_stock_at_closing`, COGS/anglo-saxon valuation are gone. |
| `mail.thread` / `mail.activity` / chatter | **Dropped.** Replaced by `audit_logs` (§ Audit). |
| `ir.sequence` | **Dropped.** Replaced by one `sequences` table with atomic `next_value` allocation. |
| `res.config.settings` | **Dropped.** It is a UI proxy over `pos_configs`/`companies` columns; no table needed. |
| `ir.module.module` feature detection | **Dropped.** Replaced by `pos_configs.feature_*` boolean flags + `settings`. |
| `portal.mixin` / website / link.tracker | **Dropped.** Kept `pos_orders.access_token` + `pos_orders.ticket_code` for the receipt/invoice self-service URL; QR shortening is a service concern, not a table. |
| `resource.calendar` | **Collapsed** into `preset_service_windows` (weekday + from/to hour) — no leaves, no timezone calendars beyond the company timezone. |
| `product.removal`, `uom.category` full engine, `product.supplierinfo`, `digest.digest` | **Dropped** (`uom_categories` kept in a minimal form for conversion sanity). |
| `res.groups` / `ir.model.access` / `ir.rule` | **Collapsed** into `roles` + `permissions` + `permission_role` + `role_user` and per-config employee access levels. |

### 0.9 What was deliberately KEPT at full fidelity
1. **Tax engine**: `tax_groups`, `taxes` (percent / fixed / division "tax-included-in-price" /
   group), `tax_children` for compound & group taxes, `price_include`, `include_base_amount`,
   `is_base_affected`, `has_negative_factor`, per-tax `sequence`, and `fiscal_positions` +
   `fiscal_position_taxes` mapping. Order lines persist both `price_subtotal` and
   `price_subtotal_incl` **and** a per-line `tax_details` JSON breakdown so a receipt can be
   re-rendered byte-identically years later.
2. **Pricelists**: `pricelists` + `pricelist_items` with every rule dimension (variant / template /
   pos category / global, `min_quantity`, `date_start`/`date_end`, `compute_price` fixed|percentage|
   formula, `price_surcharge`, `price_discount`, `price_round`, `price_min_margin`,
   `price_max_margin`, `base` list_price|standard_price|pricelist, `base_pricelist_id`).
3. **Variants & attributes**: template → attribute lines → values → generated variants, with
   `price_extra`, `is_custom` free-text values, `no_variant` attributes riding on the order line,
   and exclusion pairs.
4. **Combos** with `qty_free` / `qty_max` / `base_price` / per-item `extra_price` and the
   proportional free-quota price distribution (server-authoritative).
5. **POS category tree** with images, colours, `sequence`, and `hour_after`/`hour_until`
   availability windows.
6. **Barcode nomenclatures & rules** (product / weight / price / discount / customer / cashier /
   coupon patterns, company nomenclature + per-config fallback).
7. **uuid-first offline sync** on every client-created record.

---

## 1. ERD overview (by domain)

Notation: `A ─< B` = A hasMany B; `A >─< B` = many-to-many (pivot named in parentheses);
`A ─ B` = one-to-one / belongsTo; `(self)` = self-referencing.

### 1.1 Identity, access & devices
```
companies ─< users ─< role_user >─ roles ─< permission_role >─ permissions
companies ─< employees ─────────────────────────────┐
employees ─ users (optional 1:1 link)               │
pos_configs >─< employees (pos_config_employee: access_level minimal|basic|advanced, role_slug→till_roles.slug)
companies ─< customers (self: parent_id → billing/delivery children)
customers ─< customer_addresses (optional flattened alternative — see table note)
pos_configs ─< pos_devices (device_identifier, has_paper, last_seen_at)
companies ─< countries? (no — global) : countries ─< country_states
languages (global)
```

### 1.2 Catalog
```
companies ─< pos_categories (self: parent_id)  ─< pos_category_product >─ products
companies ─< product_categories (self: parent_id)   ─< products
products ─< product_variants ──< product_packagings (per-uom barcode)
products >─< product_tags (product_tag_product)
products >─< products (product_optional_products: upsell/cross-sell, self m2m)
products ─< product_attribute_lines >─ product_attributes ─< product_attribute_values
product_attribute_lines ─< product_attribute_line_values (price_extra, per-template value)
product_variants >─< product_attribute_line_values (product_variant_attribute_value)
product_attribute_lines ─< product_attribute_exclusions (value ↔ value, self-ish)
combos ─< combo_items ─ product_variants
products >─< combos (combo_product: which templates are combo "meals")
uom_categories ─< uoms ─< products
barcode_nomenclatures ─< barcode_rules
media_files (polymorphic: model_type/model_id/collection)
```

### 1.3 Pricing & tax
```
currencies ─< currency_rates
companies ─< pricelists ─< pricelist_items ─ (product_variants | products | pos_categories | pricelists[base])
companies ─< tax_groups ─< taxes ─< tax_children (self m2m: compound/group)
taxes >─< products (product_tax)   taxes >─< product_variants (product_variant_tax, override)
companies ─< fiscal_positions ─< fiscal_position_taxes (tax_src → tax_dest, nullable dest = removal)
companies ─< cash_roundings
decimal_precisions (global)
```

### 1.4 POS configuration
```
companies ─< pos_configs ──┬─< sequences (order/receipt/line/device/session per config)
                           ├─>< payment_methods       (pos_config_payment_method)
                           ├─>< pricelists            (pos_config_pricelist)
                           ├─>< fiscal_positions      (pos_config_fiscal_position)
                           ├─>< pos_presets           (pos_config_preset)
                           ├─>< pos_printers          (pos_config_printer)
                           ├─>< pos_notes             (pos_config_note)
                           ├─>< pos_bills             (pos_config_bill)
                           ├─>< pos_categories        (pos_config_pos_category: limit_categories)
                           ├─>< pos_configs (self)    (pos_config_trusted_config)
                           ├─>< restaurant_floors     (pos_config_floor)
                           ├─>< languages             (pos_config_language: self-order langs)
                           ├─>< prep_displays         (pos_config_prep_display)
                           └─>< self_order_custom_links (pos_config_self_order_custom_link)
pos_presets ─< preset_service_windows
pos_printers >─< pos_categories (pos_category_pos_printer: routing)
payment_methods ─ payment_providers (online)
companies ─< notification_templates (email/sms receipt + preset confirmation)
settings (global key/value)
```

### 1.5 Sessions & cash
```
pos_configs ─< pos_sessions ──┬─< pos_orders
                              ├─< cash_movements
                              ├─< session_cash_counts ─< session_cash_count_lines (denominations)
                              ├─< session_payment_totals  (per payment_method: expected/counted/diff)
                              ├─< session_sales_summaries (per tax/category/product: qty, base, discount)
                              ├─< session_tax_summaries   (per tax: base, amount, refund split)
                              └─ accounting_exports (batch of sessions → file)
employees ─< cash_movements (who)
```

### 1.6 Orders
```
pos_sessions ─< pos_orders ──┬─< pos_order_lines ──┬─< pos_order_line_custom_attribute_values
                             │                     ├─>< product_attribute_line_values (pos_order_line_attribute_value)
                             │                     └─ pos_order_lines (self: combo_parent_id, refunded_order_line_id)
                             ├─< pos_payments ─ payment_transactions (online)
                             ├─< restaurant_order_courses (restaurant domain)
                             ├─< pos_order_loyalty_points
                             ├─ pos_invoices ─< pos_invoice_lines
                             └─ pos_orders (self: refunded_order_id, split_from_order_id, merged_into_order_id)
customers ─< pos_orders     employees ─< pos_orders     pos_presets ─< pos_orders
payment_providers ─< payment_transactions
```

### 1.7 Restaurant
```
companies ─< restaurant_floors ─< restaurant_tables (self: parent_id = physical link/merge)
restaurant_floors >─< pos_configs (pos_config_floor)
restaurant_tables ─< pos_orders (table_id, self_order_table_id)
pos_orders ─< restaurant_order_courses ─< pos_order_lines (course_id)
pos_orders ─< pos_order_merges (audit + unmerge restore payload)
```

### 1.8 Kitchen (preparation display + printing)
```
companies ─< prep_displays ──┬─>< pos_categories (pos_category_prep_display: routing)
                             ├─>< pos_configs    (pos_config_prep_display)
                             └─< prep_stages (columns: To Do / Cooking / Ready …)
pos_orders ─< prep_orders ─< prep_order_lines ─< prep_line_stage_logs
prep_order_lines ─ prep_stages (current stage) / restaurant_order_courses (course_id)
pos_orders ─ order_preparation_snapshots (1:1 baseline for the delta engine)
pos_printers ─< preparation_print_jobs (queue, idempotent, retry)
```

### 1.9 Self-order (QR / kiosk)
```
pos_configs (self_ordering_* columns) ─< self_order_custom_links (m2m)
restaurant_tables.identifier  → QR capability token
pos_orders.access_token       → per-order capability token
pos_presets (available_in_self, service_at, notification_template_id)
products.self_order_available, product_variants.self_order_available
media_files (collection: self_home / self_background / brand)
payment_providers ─< payment_transactions ─ pos_orders
```

### 1.10 Loyalty & promotions
```
companies ─< loyalty_programs ──┬─< loyalty_rules ──┬─>< products      (loyalty_rule_product)
                                │                   ├─>< pos_categories(loyalty_rule_pos_category)
                                │                   └─>< product_tags  (loyalty_rule_product_tag)
                                ├─< loyalty_rewards ─>< products (loyalty_reward_product)
                                ├─< loyalty_cards ─< loyalty_card_histories
                                ├─>< pos_configs   (loyalty_program_pos_config)
                                ├─>< pricelists    (loyalty_program_pricelist)
                                └─< loyalty_communications ─ notification_templates
pos_order_lines (is_reward_line, loyalty_reward_id, loyalty_card_id, reward_identifier_code, points_cost)
pos_orders ─< pos_order_loyalty_points ─ loyalty_cards
```

### 1.11 Audit & sync
```
audit_logs (polymorphic subject, actor = users|employees, channel)
pos_orders ─< pos_order_edit_logs
sync_requests (device + request uuid → response hash; replay protection)
sync_conflicts (uuid collisions / stale-write rejections for ops review)
broadcast: no table (Reverb/Pusher channels keyed on pos_configs.access_token)
```

---

## 2. Tables

Each entry: **purpose** → **maps from** (Odoo model) → **dropped/simplified** → column table.
In column tables, `FK→x.y` implies an index on the column (Laravel `foreignId()->constrained()`
creates it). "U" = part of a unique constraint. Column type shorthand maps 1:1 to Laravel
migration methods (`string(80)` = `$table->string('col', 80)`).

---

## 2.A Identity, access & devices

### `companies`
Legal entity / brand that owns configs, catalog and money. Root of every tenant scope.
Maps from `res.company`. Dropped: chart of accounts, journals, fiscal localisation packs, parent
company hierarchy, bank accounts, social/website fields.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| name | string(160) | |
| legal_name | string(160) nullable | printed on invoices |
| currency_id | FK→currencies.id, restrict | company currency |
| country_id | FK→countries.id nullable, restrict | fiscal country (drives tax label, VAT rules) |
| state_id | FK→country_states.id nullable | |
| vat | string(32) nullable, index | tax id |
| company_registry | string(64) nullable | |
| street, street2 | string(128) nullable | |
| city | string(96) nullable | |
| zip | string(24) nullable | |
| phone, email | string(64)/string(160) nullable | |
| website | string(160) nullable | |
| logo_media_id | FK→media_files.id nullable, set null | receipts, kiosk brand |
| timezone | string(64) default 'UTC' | all reporting day-boundaries |
| tax_calculation_rounding_method | enum('round_per_line','round_globally') default 'round_per_line' | **must** match Odoo semantics |
| price_include_default | boolean default false | new products default to tax-included prices |
| barcode_nomenclature_id | FK→barcode_nomenclatures.id nullable, set null | primary nomenclature |
| default_customer_id | FK→customers.id nullable, set null | walk-in customer |
| receipt_use_ticket_qr | boolean default true | print portal QR on receipt |
| receipt_ticket_unique_code | boolean default true | generate 5-char `ticket_code` |
| receipt_ticket_url_display_mode | enum('qr_code','url','qr_code_and_url') default 'qr_code' | |
| stale_session_alert_days | unsignedTinyInteger default 7 | replaces `_alert_old_session` cron constant |
| active | boolean default true, index | |
| timestamps | | |

### `users`
Back-office / API login (Laravel auth). A user is a *person with a password*; a cashier at the
register is an `employee` (may or may not have a user).
Maps from `res.users`. Dropped: partner linkage as identity, notification prefs, `res.groups`
(→ roles), signature, lang-per-user beyond `locale`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, restrict | |
| name | string(120) | |
| email | string(160) **unique** | login |
| email_verified_at | timestamp nullable | |
| password | string(255) | |
| remember_token | rememberToken() | |
| locale | string(8) default 'en' | |
| avatar_media_id | FK→media_files.id nullable, set null | |
| is_super_admin | boolean default false | bypasses permission checks; **cannot open a POS session** (Odoo `open_ui` guard) |
| last_login_at | timestamp nullable | |
| active | boolean default true, index | |
| timestamps, softDeletes | | |

### `roles`
Named permission bundle. Maps from `res.groups` (`group_pos_user`, `group_pos_manager`,
`group_pos_preset`, `base.group_system`). Dropped: implied-group graph (flattened at seed time),
per-model ACL rows, record rules (replaced by company scope + config scope).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| name | string(64) | 'POS Cashier', 'POS Manager', 'Admin' |
| slug | string(64) **unique** | `pos_user`, `pos_manager`, `admin` |
| description | string(255) nullable | |
| is_system | boolean default false | seeded, not deletable |
| timestamps | | |

### `permissions`
Atomic capability checked in policies. Seeded, not user-editable.
Maps from `ir.model.access` rows + the code-level gates listed in 01-pos-backend §5.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| slug | string(96) **unique** | e.g. `cash.move.create`, `cash.move.delete`, `order.price.edit`, `order.payment.edit`, `session.close`, `receipt.header.edit`, `product.create`, `margin.view`, `config.manage`, `loyalty.manage`, `session.close.over_diff` |
| group | string(48), index | UI grouping |
| description | string(255) nullable | |
| timestamps | | |

### `permission_role` (pivot)
| Column | Type | Notes |
|---|---|---|
| role_id | FK→roles.id, cascade | U with permission_id |
| permission_id | FK→permissions.id, cascade | U |

### `role_user` (pivot)
| Column | Type | Notes |
|---|---|---|
| role_id | FK→roles.id, cascade | U with user_id |
| user_id | FK→users.id, cascade | U |

### `till_roles`
What a till employee may do — permission **axis 2**. Not `roles`, which is back-office *users* and
their policy permissions; the two are never mixed.

These lived in `config/pos.php` until BAN-451 and could only change with a deploy. `TillRoleSeeder`
seeds the three the product ships with from that same config, so a venue's abilities do not change
on migration.

| column | type | notes |
|---|---|---|
| id | PK | |
| company_id | FK→companies.id, cascade | U with slug |
| slug | varchar(32) | what `employees.default_role` and `pos_config_employee.role_slug` store, and what the bootstrap payload carries |
| name | varchar(64) | what staff see |
| abilities | json | list of ability strings, filtered through `EmployeeAbilities` on read and on write |
| is_system | bool default false | the three the product ships with: renameable and re-grantable, never removable, slug frozen |
| sequence | int default 10 | matrix column order |
| active | bool default true, idx | |

The abilities themselves are **not** data: `App\Support\Auth\EmployeeAbilities` is the fixed set,
because it is code that checks them. An operator picks from it and cannot invent one — a role
granting an unknown string would otherwise make that string a real ability as far as
`ApprovalAuthority` is concerned.

### `employees`
Cashier identity at the register (badge + PIN login), and the attribution target for orders,
payments and cash movements.
Maps from `hr.employee` (via `pos_hr`). Dropped: HR (contracts, departments, leaves, attendance,
work address, manager hierarchy, private info). Kept: barcode + PIN hashes, user link, per-config
access level.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, restrict | |
| user_id | FK→users.id nullable, set null | optional back-office login for the same person |
| name | string(120), index | |
| job_title | string(80) nullable | |
| avatar_media_id | FK→media_files.id nullable, set null | login screen tile |
| barcode | string(64) nullable, **unique** (company_id, barcode) | plaintext for badge printing (back-office only) |
| barcode_hash | char(64) nullable, index | SHA-256 of barcode; **this** is what ships to the client (Odoo used SHA-1 — upgraded) |
| pin_hash | char(64) nullable | SHA-256 of PIN; never plaintext |
| default_role | varchar(16) default 'cashier' | `till_roles.slug`; fallback when no per-config override. Not an enum since BAN-451 — a venue can author its own roles — and not a FK either, because `till_roles` is per-company and this is a slug rather than an id. `TillRoleController` refuses to remove a role staff still hold. |
| color | unsignedTinyInteger default 0 | |
| active | boolean default true, index | |
| timestamps, softDeletes | | |

### `pos_config_employee` (pivot, payload)
Which employees may log in to which register, and at what privilege.
Maps from `pos.config.minimal_employee_ids / basic_employee_ids / advanced_employee_ids`.
Rule preserved: **if a config has zero rows here, every active company employee may log in.**

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_config_id | FK→pos_configs.id, cascade | U with employee_id |
| employee_id | FK→employees.id, cascade | U |
| access_level | enum('minimal','basic','advanced') default 'basic' | `advanced` ⇒ manager role on this register |
| timestamps | | |

### `customers`
Guest / account holder. Maps from `res.partner`. Dropped: supplier fields, accounting properties
(receivable/payable accounts, payment terms), company hierarchy beyond one level, industry,
website, ranks, bank accounts. Kept: address for invoicing/delivery, VAT, barcode (loyalty card
scan), preferred pricelist and fiscal position, per-customer order counter for load ordering.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | self-order + offline client can create customers |
| company_id | FK→companies.id, restrict | |
| parent_id | FK→customers.id nullable, set null | company ↔ contact (one level; used for invoice/delivery addresses) |
| address_type | enum('contact','invoice','delivery','other') default 'contact' | |
| is_company | boolean default false | |
| name | string(160), index | |
| display_name | string(200) nullable | denormalised `parent, name` |
| email | string(160) nullable, index | |
| phone | string(40) nullable, index | |
| mobile | string(40) nullable, index | |
| vat | string(32) nullable, index | |
| street, street2 | string(128) nullable | |
| city | string(96) nullable | |
| zip | string(24) nullable, index | |
| state_id | FK→country_states.id nullable, set null | |
| country_id | FK→countries.id nullable, set null | |
| barcode | string(64) nullable, unique(company_id, barcode) | customer badge scan |
| locale | string(8) nullable | receipt language |
| pricelist_id | FK→pricelists.id nullable, set null | `property_product_pricelist` |
| fiscal_position_id | FK→fiscal_positions.id nullable, set null | auto-applied tax mapping |
| loyalty_points_cache | decimal(16,3) default 0 | denormalised sum of active loyalty cards (display only) |
| account_balance | decimal(16,4) default 0, index | REG-208 — what this customer owes on account. Positive = owed to the house; negative = in credit. **Cache** of Σ`customer_account_moves.amount`, written in the same transaction under a row lock; the moves are the record |
| order_count | unsignedInteger default 0, index | drives "top-N customers" preload ordering (replaces Odoo's raw SQL) |
| last_order_at | timestamp nullable, index | |
| marketing_opt_in | boolean default false | |
| note | text nullable | |
| active | boolean default true, index | |
| timestamps, softDeletes | | |

> **Dropped table note:** a separate `customer_addresses` table was considered and rejected — Odoo
> models addresses as child partners, and the POS only ever needs one invoice + one delivery
> address. `parent_id` + `address_type` reproduces that with zero extra joins.

### `pos_devices`
One physical register / kiosk / customer-display attached to a config. Gives each device a stable
short identifier used inside receipt numbers and a home for device-local state.
Maps from `pos.config.device_seq_id` + `register_new_device_identifier()` + kiosk `has_paper`.
Dropped: IoT box device inventory (kept as connection settings on `pos_configs`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | client-generated; survives browser storage wipes via re-registration |
| pos_config_id | FK→pos_configs.id, cascade | |
| device_identifier | unsignedInteger | per-config incrementing number used in `receipt_number` |
| name | string(80) nullable | "Bar terminal 2" |
| device_type | enum('register','kiosk','customer_display','self_mobile','prep_display') default 'register' | |
| user_agent | string(255) nullable | |
| hardware_fingerprint | string(128) nullable **indexed** | identifies the physical machine, so a re-paired terminal is recognised rather than added again (BAN-456) |
| app_version | string(32) nullable | the client build this device last reported; recorded at pairing and refreshed on sync |
| paired_at | timestamp nullable | when this device was enrolled, kept separate from `created_at` so a re-pair can be told from a first pair |
| last_seen_at | timestamp nullable, index | |
| last_synced_at | timestamp(3) nullable | server clock at last successful bootstrap/delta — client echoes it back as `since` |
| has_paper | boolean default true | kiosk printer paper status (`/change-printer-status`) |
| current_employee_id | FK→employees.id nullable, set null | logged-in cashier (for the closing popup "who is on which till") |
| active | boolean default true | |
| timestamps | | |
| unique | (pos_config_id, device_identifier) | |

### `countries`
Global lookup. Maps from `res.country`. Dropped: address-format templates, phone code lists beyond
`phone_code`, currency link.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| name | string(96) | |
| code | char(2) **unique** | ISO-3166-1 alpha-2 |
| phone_code | unsignedSmallInteger nullable | |
| vat_label | string(32) nullable | "VAT", "TVA", "MWSt" — printed on receipts |
| currency_id | FK→currencies.id nullable, set null | |
| requires_state | boolean default false | drives self-order address form |
| timestamps | | |

### `country_states`
Maps from `res.country.state`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| country_id | FK→countries.id, cascade | |
| name | string(96) | |
| code | string(8) | unique(country_id, code) |
| timestamps | | |

### `languages`
UI languages selectable in the register / self-order app. Maps from `res.lang`. Dropped: date/time
format strings, grouping, direction (moved to a static config file).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| code | string(8) **unique** | `en_US`, `fr_FR` |
| iso_code | string(5) | `en`, `fr` |
| name | string(64) | |
| flag_url | string(255) nullable | |
| is_rtl | boolean default false | |
| active | boolean default true, index | |
| sequence | integer default 10 | |
| timestamps | | |

### `media_files`
Every image/attachment (product photos, category tiles, floor backgrounds, kiosk carousels, brand
logos, receipt images). Polymorphic.
Maps from `ir.attachment` + Odoo's inline `image_512`/`image_128` binary fields.
Dropped: `ir.attachment` ACL machinery, res_field indirection, url-type attachments.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id nullable, cascade | |
| model_type | string(96) nullable, index | polymorphic (`App\Models\Product`, …) |
| model_id | unsignedBigInteger nullable, index | |
| collection | string(48) default 'default', index | `image`, `self_home`, `self_background`, `brand`, `floor_background`, `receipt_logo` |
| disk | string(24) default 'public' | |
| path | string(512) | |
| filename | string(255) | |
| mime_type | string(96) | |
| size_bytes | unsignedBigInteger | |
| width, height | unsignedSmallInteger nullable | |
| checksum | char(64), index | sha-256; dedupes re-uploads |
| variants | json nullable | `{"128":"path","512":"path","1024":"path"}` pre-generated thumbnails |
| is_public | boolean default false | self-order menu images must be publicly fetchable without auth |
| sort_order | integer default 0 | carousel ordering |
| timestamps | | |
| index | (model_type, model_id, collection, sort_order) | |

---

## 2.B Catalog

### `pos_categories`
The register's browsing tree (distinct from accounting/product categories).
Maps from `pos.category`. Dropped: nothing meaningful. Added: `path` materialised path for fast
descendant queries (replaces Odoo `parent_path`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| parent_id | FK→pos_categories.id nullable, cascade | cycle-guarded in app |
| name | string(96) | |
| path | string(512), index | `/1/7/22/` materialised path |
| depth | unsignedTinyInteger default 0 | |
| sequence | integer default 10, index | |
| color | unsignedTinyInteger default 0 | 0–11 palette index |
| image_media_id | FK→media_files.id nullable, set null | |
| hour_after | decimal(5,2) nullable | availability window start (0–24); NULL = always |
| hour_until | decimal(5,2) nullable | availability window end; CHECK `hour_until >= hour_after` |
| self_order_visible | boolean default true | hide a category from QR/kiosk menus only |
| active | boolean default true, index | |
| timestamps | | |
| unique | (company_id, parent_id, name) | |

### `product_categories`
Internal/reporting category (single tree, used for sales grouping and loyalty rule scoping).
Maps from `product.category`. Dropped: property accounts, costing method, removal strategy,
valuation — all ERP.

`path` is a materialised path of **ids, terminated** — `/4/9/22/` — so `scopeDescendantsOf`'s
`LIKE path%` means "this branch" and nothing else. Both halves matter and neither held before
BAN-501: name paths made `/Boissons` a prefix of `/Boissons speciales`, sweeping an unrelated
sibling into the subtree, and forced a rewrite of every descendant on a rename. Ids do not change,
so only a *move* touches the path, and `/1/` cannot prefix `/11/`. `App\Services\Catalog\CategoryTree`
is the only writer; `pos_categories` follows the same rule (BAN-422).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| parent_id | FK→product_categories.id nullable, cascade | |
| name | string(96) | |
| path | string(512), index | materialised path of **ids, terminated** (`/4/9/22/`); written only by `CategoryTree` |
| sequence | integer default 10 | |
| ledger_code | string(32) nullable | revenue account this category's sales post to; the source of `session_sales_summaries.ledger_code` |
| timestamps | | |

### `products`
Product template — the sellable concept. Every product has ≥1 `product_variants` row (an
attribute-less product has exactly one).
Maps from `product.template` (+ POS extension fields). Dropped: purchase/route/BoM/company-property
fields, `type` beyond a POS-relevant enum, supplier info, invoicing policy, expense policy,
`standard_price` kept (needed for margin display) but with no valuation layers.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | register can create products offline |
| company_id | FK→companies.id, cascade | |
| name | string(200), index | |
| product_category_id | FK→product_categories.id nullable, set null | |
| product_type | enum('consumable','service','combo') default 'consumable' | `combo` = a meal whose price is composed from `combos` |
| default_code | string(64) nullable, index | internal reference |
| barcode | string(64) nullable | template-level convenience; authoritative barcodes live on variants — unique(company_id, barcode) |
| uom_id | FK→uoms.id, restrict | selling unit |
| list_price | decimal(16,4) default 0 | sales price of the template (variant `price_extra` adds on top) |
| standard_price | decimal(16,4) default 0 | cost (margin display only) |
| tax_ids | *(via `product_tax` pivot)* | |
| available_in_pos | boolean default true, index | |
| self_order_available | boolean default true, index | forced false when `available_in_pos` false |
| to_weight | boolean default false | send to electronic scale |
| track_stock | boolean default false | enables the lightweight on-hand counter |
| allow_negative_stock | boolean default true | |
| is_special | boolean default false, index | tip / global-discount / reward products: always pushed to client, never browsable |
| special_kind | enum('none','tip','global_discount','loyalty_reward','deposit') default 'none' | |
| description_sale | text nullable | printed on receipt |
| public_description | text nullable | HTML, shown on self-order menu |
| internal_note | text nullable | |
| color | unsignedTinyInteger default 0 | derived from first POS category at write time |
| pos_sequence | integer default 0, index | manual ordering on the product screen |
| is_favorite | boolean default false, index | boosts limited-load ordering |
| last_sold_at | timestamp nullable, index | denormalised recency — drives the limited-load ordering (replaces Odoo's "last stock-move date" SQL) |
| sale_count | unsignedInteger default 0 | denormalised popularity, tie-breaker for the product cap |
| image_media_id | FK→media_files.id nullable, set null | |
| has_image | boolean default false | denormalised flag: the client only needs to know *whether* to request an image |
| attribute_count | unsignedTinyInteger default 0 | denormalised: >0 ⇒ open the configurator |
| combo_count | unsignedTinyInteger default 0 | denormalised: >0 ⇒ open the combo stepper |
| sale_ok | boolean default true | |
| active | boolean default true, index | |
| timestamps, softDeletes | | |
| index | (company_id, available_in_pos, active) | catalog bootstrap |
| index | (company_id, self_order_available, active) | self-order bootstrap |

### `product_variants`
The actually-sold SKU. Maps from `product.product`.
Dropped: stock quants, valuation layers, supplier info, packaging beyond barcodes.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| product_id | FK→products.id, cascade | |
| company_id | FK→companies.id, cascade | denormalised for scoping |
| name_suffix | string(160) nullable | "(Large, Red)" — precomputed display suffix |
| display_name | string(255), index | precomputed `product.name (attrs)`; what receipts/kitchen tickets print |
| default_code | string(64) nullable, index | |
| barcode | string(64) nullable | unique(company_id, barcode) |
| price_extra | decimal(16,4) default 0 | Σ of its attribute values' `price_extra` (denormalised) |
| list_price | decimal(16,4) nullable | variant price override; NULL ⇒ `products.list_price + price_extra` |
| standard_price | decimal(16,4) default 0 | |
| on_hand_qty | decimal(16,3) default 0 | lightweight counter, only when `products.track_stock` |
| self_order_available | boolean default true, index | per-variant availability (86'ing a size) |
| is_active_combination | boolean default true, index | false = attribute combination excluded |
| image_media_id | FK→media_files.id nullable, set null | |
| active | boolean default true, index | |
| timestamps, softDeletes | | |

### `pos_category_product` (pivot)
Maps from `product.template.pos_categ_ids`.

| Column | Type | Notes |
|---|---|---|
| pos_category_id | FK→pos_categories.id, cascade | U |
| product_id | FK→products.id, cascade | U |
| sequence | integer default 10 | position of the product inside this category |

### `product_tags` / `product_tag_product`
Merchandising tags shown on the self-order menu ("Spicy", "Vegan"). Maps from `product.tag`
(+ `pos_description`, `visible_to_customers`).

`product_tags`
| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | unique(company_id, name) |
| color | unsignedTinyInteger default 0 | |
| description | text nullable | HTML shown in the self-order product popup |
| image_media_id | FK→media_files.id nullable, set null | |
| visible_to_customers | boolean default true, index | |
| sequence | integer default 10 | |
| timestamps | | |

`product_tag_product` (pivot): `product_tag_id` FK cascade U, `product_id` FK cascade U.

### `product_optional_products` (pivot, self m2m)
Upsell / cross-sell suggestions. Maps from `product.template.pos_optional_product_ids`.

| Column | Type | Notes |
|---|---|---|
| product_id | FK→products.id, cascade | U — the "trigger" product |
| optional_product_id | FK→products.id, cascade | U — the suggestion |
| sequence | integer default 10 | |

### `product_attributes`
Maps from `product.attribute`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(96) | |
| display_type | enum('radio','pills','select','color','multi') default 'radio' | |
| create_variant | enum('always','dynamic','no_variant') default 'always' | `no_variant` values ride on the order line |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |

### `product_attribute_values`
Global value pool for an attribute ("Red", "XL"). Maps from `product.attribute.value`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| product_attribute_id | FK→product_attributes.id, cascade | |
| name | string(96) | unique(product_attribute_id, name) |
| html_color | string(9) nullable | `#RRGGBB[AA]` for colour swatches |
| image_media_id | FK→media_files.id nullable, set null | |
| is_custom | boolean default false | value accepts a free-text companion (e.g. "Other: ___") |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |

### `product_attribute_lines`
"This template uses attribute X with these values". Maps from `product.template.attribute.line`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| product_id | FK→products.id, cascade | |
| product_attribute_id | FK→product_attributes.id, restrict | unique(product_id, product_attribute_id) |
| is_required | boolean default true | self-order "missing required details" gate |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |

### `product_attribute_line_values`
The per-template instance of a value, carrying the **price extra**. This is Odoo's
`product.template.attribute.value` — the id that order lines actually reference.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| product_attribute_line_id | FK→product_attribute_lines.id, cascade | |
| product_attribute_value_id | FK→product_attribute_values.id, restrict | unique(line_id, value_id) |
| product_id | FK→products.id, cascade | denormalised (avoids a join on every price computation) |
| price_extra | decimal(16,4) default 0 | added to the variant price |
| sequence | integer default 10 | |
| active | boolean default true, index | Odoo `ptav_active` |
| timestamps | | |

### `product_variant_attribute_value` (pivot)
Which template-attribute-values compose a given variant. Maps from
`product.product.product_template_variant_value_ids`.

| Column | Type | Notes |
|---|---|---|
| product_variant_id | FK→product_variants.id, cascade | U |
| product_attribute_line_value_id | FK→product_attribute_line_values.id, cascade | U |

### `product_attribute_exclusions`
"If value A is chosen, value B is impossible." Maps from `product.template.attribute.exclusion`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| product_id | FK→products.id, cascade | |
| product_attribute_line_value_id | FK→product_attribute_line_values.id, cascade | the chosen value |
| excluded_value_id | FK→product_attribute_line_values.id, cascade | the value it forbids |
| timestamps | | |
| unique | (product_attribute_line_value_id, excluded_value_id) | |

### `combos`
A choice group inside a meal ("Pick a drink"). Maps from `product.combo`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(96) | |
| base_price | decimal(16,4) default 0 | reference price used for proportional free-quota distribution |
| qty_free | unsignedSmallInteger default 1 | picks included in the meal price (≥0, ≤ qty_max) |
| qty_max | unsignedSmallInteger default 1 | max picks (≥1) |
| sequence | integer default 10 | stepper order |
| active | boolean default true | |
| timestamps | | |

### `combo_items`
A pickable option inside a combo. Maps from `product.combo.item`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| combo_id | FK→combos.id, cascade | |
| product_variant_id | FK→product_variants.id, restrict | unique(combo_id, product_variant_id) |
| extra_price | decimal(16,4) default 0 | supplement over the free quota |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |

### `combo_product` (pivot)
Which combos a meal product is composed of. Maps from `product.template.combo_ids`.

| Column | Type | Notes |
|---|---|---|
| product_id | FK→products.id, cascade | U |
| combo_id | FK→combos.id, cascade | U |
| sequence | integer default 10 | |

### `uom_categories` / `uoms`
Minimal unit-of-measure support (Units, kg, g, L, hour). Maps from `uom.category` / `uom.uom`
(+ POS `is_pos_groupable`). Dropped: purchase UoM, rounding-per-uom beyond `rounding`,
uom-based stock conversions.

`uom_categories`: `id`, `name` string(64), `timestamps`.

`uoms`
| Column | Type | Notes |
|---|---|---|
| id | id | |
| uom_category_id | FK→uom_categories.id, restrict | |
| name | string(48) | |
| uom_type | enum('reference','bigger','smaller') default 'reference' | |
| factor | decimal(24,12) default 1 | ratio to the category reference |
| rounding | decimal(12,6) default 0.01 | qty rounding step |
| is_pos_groupable | boolean default true | identical lines merge on the register |
| active | boolean default true | |
| timestamps | | |

### `product_packagings`
Per-packaging barcode ("case of 12"). Maps from Odoo 19 `product.uom` (packaging barcodes).
Dropped: purchase/sales packaging flags, qty-per-package beyond `qty`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| product_variant_id | FK→product_variants.id, cascade | |
| uom_id | FK→uoms.id, restrict | |
| name | string(64) nullable | |
| qty | decimal(16,3) default 1 | base-uom quantity this barcode represents |
| barcode | string(64) | unique(company_id-through-variant, barcode) enforced app-side; index |
| timestamps | | |

### `barcode_nomenclatures`
Maps from `barcode.nomenclature`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id nullable, cascade | NULL = global |
| name | string(64) | |
| upc_ean_conv | enum('none','ean2upc','upc2ean','always') default 'always' | |
| is_gs1 | boolean default false | |
| timestamps | | |

### `barcode_rules`
Maps from `barcode.rule` (+ POS rule types). Kept in full: this is how weighed/priced/discount
labels and cashier/customer badges are decoded offline.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| barcode_nomenclature_id | FK→barcode_nomenclatures.id, cascade | |
| name | string(64) | |
| rule_type | enum('product','weight','price','discount','customer','cashier','coupon','lot','package','alias') | see §4.10 |
| pattern | string(64) | e.g. `21.....{NNDDD}` |
| encoding | enum('any','ean13','ean8','upca','gs1_128') default 'any' | |
| alias | string(64) nullable | for `alias` rules |
| sequence | integer default 10, index | evaluation order |
| active | boolean default true | |
| timestamps | | |

---

## 2.C Pricing & tax

### `currencies`
Maps from `res.currency`. Dropped: rate provider integration, per-company rate tables (rates live
in `currency_rates`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| code | char(3) **unique** | ISO-4217 |
| name | string(64) | |
| symbol | string(8) | |
| symbol_position | enum('before','after') default 'after' | |
| decimal_places | unsignedTinyInteger default 2 | |
| rounding | decimal(12,6) default 0.01 | smallest representable increment |
| iso_numeric | unsignedSmallInteger nullable | for payment QR payloads (EMVCo) |
| active | boolean default true, index | |
| timestamps | | |

### `currency_rates`
Historical rate against the company currency (needed to freeze `pos_orders.currency_rate`).
Maps from `res.currency.rate`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| currency_id | FK→currencies.id, cascade | |
| company_id | FK→companies.id, cascade | |
| rate_date | date | unique(currency_id, company_id, rate_date) |
| rate | decimal(24,12) | units of this currency per 1 company currency |
| timestamps | | |

### `tax_groups`
Receipt grouping of taxes ("VAT 21%", "Eco-tax"). Maps from `account.tax.group`.
Dropped: advance-tax accounts, country/tax-payable accounts.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| receipt_label | string(64) nullable | `pos_receipt_label` — what prints in the tax block |
| sequence | integer default 10, index | receipt ordering |
| timestamps | | |

### `taxes`
**First-class, full fidelity.** Maps from `account.tax`. Dropped: repartition lines / tax tags /
tax grids / cash-basis / `type_tax_use` purchase side / country-specific python code. Kept
everything the client-side tax engine needs to reproduce Odoo's numbers exactly.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| tax_group_id | FK→tax_groups.id, restrict | |
| name | string(96) | |
| description | string(64) nullable | short label on the receipt line ("21%") |
| amount_type | enum('percent','fixed','division','group') default 'percent' | see §4.9 |
| amount | decimal(9,4) default 0 | % for percent/division, currency amount for fixed |
| price_include | boolean default false | the product price already contains this tax |
| include_base_amount | boolean default false | subsequent taxes compute on base+this tax (compound) |
| is_base_affected | boolean default true | this tax's base is affected by preceding `include_base_amount` taxes |
| has_negative_factor | boolean default false | withholding-style negative repartition |
| sequence | integer default 10, index | **evaluation order — load-bearing** |
| rounding_strategy | enum('inherit','round_per_line','round_globally') default 'inherit' | `inherit` = company setting |
| is_used | boolean default false | denormalised guard: cannot edit tax math while used by an unposted order line |
| active | boolean default true, index | |
| timestamps | | |
| index | (company_id, active, sequence) | |

### `tax_children` (pivot, self m2m)
Composition for `amount_type='group'` and compound chains. Maps from `account.tax.children_tax_ids`.

| Column | Type | Notes |
|---|---|---|
| parent_tax_id | FK→taxes.id, cascade | U |
| child_tax_id | FK→taxes.id, cascade | U |
| sequence | integer default 10 | order inside the group |

### `product_tax` (pivot)
Default sales taxes of a template. Maps from `product.template.taxes_id`.

| Column | Type | Notes |
|---|---|---|
| product_id | FK→products.id, cascade | U |
| tax_id | FK→taxes.id, restrict | U |

### `product_variant_tax` (pivot)
Optional per-variant tax override (rare, but Odoo allows a variant to carry different taxes via
company-specific setups; also used for 86'ing a takeaway rate on one size).
**Rule:** if a variant has ≥1 row here, it *replaces* the template's taxes; otherwise the template's
apply.

| Column | Type | Notes |
|---|---|---|
| product_variant_id | FK→product_variants.id, cascade | U |
| tax_id | FK→taxes.id, restrict | U |

### `fiscal_positions`
Tax mapping profile (takeaway vs eat-in rates, export, exemptions).
Maps from `account.fiscal.position`. Dropped: account mapping (`account.fiscal.position.account`),
auto-apply-by-country/VAT rules beyond a simple flag set, `foreign_vat`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(96) | |
| auto_apply | boolean default false | |
| country_id | FK→countries.id nullable, set null | auto-apply scope |
| state_id | FK→country_states.id nullable, set null | |
| zip_from, zip_to | string(24) nullable | |
| vat_required | boolean default false | |
| sequence | integer default 10 | |
| active | boolean default true, index | |
| timestamps | | |

### `fiscal_position_taxes`
The mapping rows. `tax_dest_id = NULL` means "remove this tax" (exemption).
Maps from `account.fiscal.position.tax`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| fiscal_position_id | FK→fiscal_positions.id, cascade | |
| tax_src_id | FK→taxes.id, cascade | |
| tax_dest_id | FK→taxes.id nullable, cascade | NULL = drop the source tax |
| timestamps | | |
| unique | (fiscal_position_id, tax_src_id, tax_dest_id) | allows 1→N mapping |

### `pricelists`
Maps from `product.pricelist`. Dropped: `discount_policy` (Odoo 17-), country-group auto-selection.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| currency_id | FK→currencies.id, restrict | must equal the config currency to be usable on a register |
| name | string(96) | |
| sequence | integer default 10 | |
| active | boolean default true, index | |
| timestamps | | |

### `pricelist_items`
**Full rule fidelity** — the client computes prices offline with these rows.
Maps from `product.pricelist.item`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pricelist_id | FK→pricelists.id, cascade | |
| company_id | FK→companies.id, cascade | denormalised |
| applied_on | enum('variant','product','pos_category','global') default 'global' | resolution specificity, most specific wins |
| product_variant_id | FK→product_variants.id nullable, cascade | when `applied_on=variant` |
| product_id | FK→products.id nullable, cascade | when `applied_on=product` |
| pos_category_id | FK→pos_categories.id nullable, cascade | when `applied_on=pos_category` (matches the category **and its descendants**) |
| min_quantity | decimal(16,3) default 0, index | rule applies from this qty up |
| date_start | timestamp nullable, index | |
| date_end | timestamp nullable, index | |
| compute_price | enum('fixed','percentage','formula') default 'fixed' | |
| fixed_price | decimal(16,4) default 0 | `compute_price=fixed` |
| percent_price | decimal(9,4) default 0 | `compute_price=percentage` (discount %) |
| base | enum('list_price','standard_price','pricelist') default 'list_price' | formula base |
| base_pricelist_id | FK→pricelists.id nullable, restrict | when `base='pricelist'` |
| price_discount | decimal(9,4) default 0 | formula: % off the base |
| price_surcharge | decimal(16,4) default 0 | formula: absolute add-on |
| price_round | decimal(12,6) default 0 | formula: round result to this step |
| price_min_margin | decimal(16,4) default 0 | formula: floor = cost + margin |
| price_max_margin | decimal(16,4) default 0 | formula: cap = cost + margin |
| sequence | integer default 10 | tie-break within equal specificity |
| active | boolean default true, index | |
| timestamps | | |
| index | (pricelist_id, applied_on, product_variant_id) | |
| index | (pricelist_id, applied_on, product_id) | |
| index | (pricelist_id, date_start, date_end) | incremental sync of newly-active rules |

> **Resolution order (documented contract, must match server & client):**
> filter by date window and `min_quantity`, then pick the first match in specificity order
> `variant → product → pos_category (nearest ancestor first) → global`, tie-broken by
> `sequence, id`. Identical to Odoo's `_compute_price_rule`.

### `cash_roundings`
Maps from `account.cash.rounding`. Simplified: only the `add_line` strategy exists (Odoo's
`biggest_tax` strategy is dropped — Odoo itself constrains POS to `add_invoice_line`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| rounding | decimal(12,6) default 0.05 | e.g. 0.05 for 5-cent rounding |
| rounding_method | enum('half_up','up','down') default 'half_up' | |
| timestamps | | |

### `decimal_precisions`
Client-side rounding digits per domain. Maps from `decimal.precision`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| name | string(64) **unique** | `Product Price`, `Product Unit of Measure`, `Discount`, `Payment Terminal` |
| digits | unsignedTinyInteger default 2 | |
| timestamps | | |

---

## 2.D POS configuration

### `pos_configs`
One register/terminal profile. The widest table in the schema — deliberately, because it is Odoo's
`pos.config` and everything about a register's behaviour hangs off it.
Maps from `pos.config` (+ `pos_restaurant`, `pos_self_order`, `pos_hr`, `pos_discount`,
`pos_online_payment` extensions). Dropped: `journal_id`/`invoice_journal_id`,
`picking_type_id`/`warehouse_id`/`route_id`/`ship_later`/`picking_policy`, all `module_pos_*`
installer booleans (→ `feature_*` flags), `group_pos_manager_id`/`group_pos_user_id` passthrough,
onboarding scenario loaders.

**Identity & infra**
| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | stable id across restores |
| company_id | FK→companies.id, cascade | |
| name | string(96), index | |
| sequence_prefix | string(8) nullable | what order and session numbers are prefixed with (BOF-045). Null derives it from `name`, which is what `SequenceService::prefixFor()` always did — and why renaming a register used to renumber every document after the rename. Letters and digits only: it is glued onto the number with a slash. |
| access_token | char(32) **unique** | public capability token: self-order URL, customer display, **broadcast channel name** |
| currency_id | FK→currencies.id, restrict | register currency; pricelists/payment methods must match |
| cash_rounding_id | FK→cash_roundings.id nullable, restrict | |
| use_cash_rounding | boolean default false | |
| only_round_cash_payments | boolean default true | |
| config_revision | unsignedInteger default 1 | bumped whenever any client-visible config/catalog scoping changes → client decides full reload (replaces `last_data_change`) |
| last_config_change_at | timestamp(3) nullable | companion to `config_revision` |
| active | boolean default true, index | |

**Catalog & pricing**
| Column | Type | Notes |
|---|---|---|
| pricelist_id | FK→pricelists.id nullable, restrict | default pricelist; must be in `pos_config_pricelist` |
| use_pricelists | boolean default false | |
| limit_categories | boolean default false | |
| tax_display | enum('subtotal','total') default 'subtotal' | price display: tax-excluded vs included |
| use_fiscal_positions | boolean default false | `tax_regime_selection` |
| default_fiscal_position_id | FK→fiscal_positions.id nullable, restrict | |
| show_product_images | boolean default true | |
| show_category_images | boolean default true | |
| group_products_by_category | boolean default false | `iface_group_by_categ` |
| allow_manual_discount | boolean default true | per-line discount |
| restrict_price_control | boolean default false | only managers change prices |
| show_margins_to_all | boolean default false | |

**Presets & tips**
| Column | Type | Notes |
|---|---|---|
| use_presets | boolean default false | |
| default_preset_id | FK→pos_presets.id nullable, restrict | |
| enable_tips | boolean default false | `iface_tipproduct` |
| tip_product_id | FK→products.id nullable, restrict | |
| tip_after_payment | boolean default false | restaurant tip-adjust flow; forced false unless `is_restaurant && enable_tips` |

**Payments**
| Column | Type | Notes |
|---|---|---|
| has_cash_control | boolean default false | denormalised: any linked cash payment method |
| set_maximum_difference | boolean default false | |
| amount_authorized_diff | decimal(16,4) nullable | max counted-vs-expected gap a non-manager may close with |
| auto_validate_terminal_payment | boolean default true | |
| use_fast_payment | boolean default false | one-click payment buttons |
| self_order_online_payment_method_id | FK→payment_methods.id nullable, set null | online PM used by mobile self-order |

**Receipts**
| Column | Type | Notes |
|---|---|---|
| show_receipt_header_footer | boolean default false | |
| receipt_header | text nullable | edit gated by `receipt.header.edit` permission |
| receipt_footer | text nullable | |
| basic_receipt | boolean default false | price-less gift ticket |
| auto_print_receipt | boolean default false | |
| skip_receipt_screen | boolean default false | |

**Restaurant** (from `pos_restaurant`)
| Column | Type | Notes |
|---|---|---|
| is_restaurant | boolean default false, index | master switch (was `module_pos_restaurant`) |
| enable_split_bill | boolean default true | |
| enable_bill_print | boolean default true | pro-forma bill before payment |
| default_screen | enum('tables','register') default 'tables' | |
| idle_return_seconds | unsignedSmallInteger default 180 | auto-return to floor screen |

**Preparation / kitchen**
| Column | Type | Notes |
|---|---|---|
| use_preparation_printers | boolean default false | `is_order_printer` |
| use_preparation_display | boolean default false | KDS enabled |
| prep_auto_fire_first_course | boolean default true | ordering fires course 1 implicitly |

**Hardware**
| Column | Type | Notes |
|---|---|---|
| use_iot_box | boolean default false | `is_posbox` |
| proxy_ip | string(64) nullable | |
| iot_scan | boolean default false | barcode/card reader via proxy |
| iot_scale | boolean default false | |
| iot_print | boolean default false | |
| iot_cashdrawer | boolean default false | |
| use_epos_printer | boolean default false | `other_devices` |
| epos_printer_ip | string(128) nullable | Epson certified domain derived from serial |
| big_scrollbars | boolean default false | |
| customer_display_bg_media_id | FK→media_files.id nullable, set null | |

**Barcode**
| Column | Type | Notes |
|---|---|---|
| fallback_barcode_nomenclature_id | FK→barcode_nomenclatures.id nullable, set null | secondary nomenclature |

**Self-order** (from `pos_self_order`)
| Column | Type | Notes |
|---|---|---|
| self_ordering_mode | enum('nothing','consultation','mobile','kiosk') default 'nothing', index | |
| self_ordering_service_mode | enum('counter','table') default 'counter' | |
| self_ordering_pay_after | enum('each','meal') default 'each' | constraint matrix in §4.13 |
| self_ordering_default_language_id | FK→languages.id nullable, set null | |
| self_ordering_default_user_id | FK→users.id nullable, restrict | rights used for anonymous self-order writes |
| self_ordering_brand_name | string(96) nullable | |
| self_ordering_brand_media_id | FK→media_files.id nullable, set null | |
| self_ordering_primary_color | string(9) nullable | `#RRGGBB` theme |
| self_ordering_text_color | string(9) nullable | |
| kiosk_idle_seconds | unsignedSmallInteger default 90 | |
| kiosk_confirmation_seconds | unsignedSmallInteger default 30 | |

**Global discount** (from `pos_discount`)
| Column | Type | Notes |
|---|---|---|
| enable_global_discount | boolean default false | |
| global_discount_percent | decimal(9,4) default 10 | |
| global_discount_product_id | FK→products.id nullable, restrict | must be `special_kind='global_discount'` |

**Feature flags & misc**
| Column | Type | Notes |
|---|---|---|
| use_employee_login | boolean default false | was `module_pos_hr` |
| enable_loyalty | boolean default false | was `module_loyalty`/`pos_loyalty` |
| enable_sms_receipt | boolean default false | was `module_pos_sms` |
| sms_template_id | FK→notification_templates.id nullable, set null | |
| email_receipt_template_id | FK→notification_templates.id nullable, set null | |
| order_edit_tracking | boolean default false | audit edited/deleted lines |
| role_abilities | json null | per-register ability overrides keyed by employee role; null means the `config/pos.php` defaults, `{}` means a deliberate override granting nothing (BOF-118) |
| min_client_version | string(32) null | the client version this register's devices are expected to be on; null falls back to the deploy-wide `pos.api.min_client_version` (BAN-456) |
| limited_product_count | unsignedInteger default 5000 | bootstrap product cap |
| limited_customer_count | unsignedInteger default 100 | bootstrap customer cap |
| timestamps, softDeletes | | |

**Guards to reproduce (application layer, not DB):** while a session is open on this config,
`is_restaurant`, `payment_method_ids`, `active`, `pos_config_floor`, `cash_rounding_id`,
`pos_config_note` and `use_employee_login` are immutable (Odoo `_get_forbidden_change_fields`).

### `pos_config_payment_method` (pivot)
`pos_config_id` FK cascade U, `payment_method_id` FK cascade U, `sequence` integer default 10,
`is_fast_payment` boolean default false (one-click button; excludes terminal/split methods).
Maps from `pos.config.payment_method_ids` + `fast_payment_method_ids`.

### `pos_config_pricelist` (pivot)
`pos_config_id` FK cascade U, `pricelist_id` FK cascade U. Maps from `available_pricelist_ids`.

### `pos_config_fiscal_position` (pivot)
`pos_config_id` FK cascade U, `fiscal_position_id` FK cascade U. Maps from `fiscal_position_ids`.

### `pos_config_preset` (pivot)
`pos_config_id` FK cascade U, `pos_preset_id` FK cascade U, `sequence` integer default 10.
Maps from `available_preset_ids`.

### `pos_config_printer` (pivot)
`pos_config_id` FK cascade U, `pos_printer_id` FK cascade U. Maps from `printer_ids`.

### `pos_config_note` (pivot)
`pos_config_id` FK cascade U, `pos_note_id` FK cascade U. Maps from `note_ids`.
(A `pos_note` with **no** rows here is global to every config of the company, the same rule as
`pos_config_bill` below. `PosNote::posLoadScope` had no such fallback until BAN-483 and returned
only linked notes — and nothing could write a link, so every register received an empty note list.)

### `pos_config_bill` (pivot)
`pos_config_id` FK cascade U, `pos_bill_id` FK cascade U. Maps from `default_bill_ids`.
(A `pos_bill` with **no** rows here is global to all configs — Odoo semantics preserved.)

### `pos_config_pos_category` (pivot)
`pos_config_id` FK cascade U, `pos_category_id` FK cascade U. Maps from `iface_available_categ_ids`;
only meaningful when `limit_categories = true`.

### `pos_config_trusted_config` (pivot, self m2m)
Registers that share open orders. Bidirectional — the app writes both rows.
`pos_config_id` FK cascade U, `trusted_config_id` FK cascade U.
Maps from `trusted_config_ids`. Constraint: both configs must share `currency_id`.

### `pos_config_floor` (pivot)
`pos_config_id` FK cascade U, `restaurant_floor_id` FK cascade U. Maps from `pos.config.floor_ids`.

### `pos_config_language` (pivot)
`pos_config_id` FK cascade U, `language_id` FK cascade U, `sequence` integer default 10.
Maps from `self_ordering_available_language_ids`.

### `pos_config_prep_display` (pivot)
`pos_config_id` FK cascade U, `prep_display_id` FK cascade U. New (KDS routing).

### `pos_config_self_order_custom_link` (pivot)
`pos_config_id` FK cascade U, `self_order_custom_link_id` FK cascade U.
Maps from `pos_self_order.custom_link.pos_config_ids` (empty ⇒ all configs).

### `sequences`
Atomic counters replacing `ir.sequence`. One row per (config, purpose[, period]).
Maps from `pos.config.order_seq_id / order_backend_seq_id / order_line_seq_id / device_seq_id`
+ the global `pos.session` sequence.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| pos_config_id | FK→pos_configs.id nullable, cascade | NULL = company-global (e.g. session names) |
| purpose | enum('order','receipt','order_line','device','session','invoice','refund') | |
| period_key | string(8) nullable | `''` or `'2026'` / `'202607'` for per-period resets |
| prefix | string(32) nullable | |
| padding | unsignedTinyInteger default 6 | |
| next_value | unsignedBigInteger default 1 | allocated with `SELECT … FOR UPDATE` or an atomic `UPDATE … RETURNING` |
| timestamps | | |
| unique | (company_id, pos_config_id, purpose, period_key) | |

> **Receipt numbering contract (unchanged from Odoo):**
> `receipt_number = "{YY}{device_identifier}-{pos_config_id}-{seq:06d}"`,
> `tracking_number = seq % 1000` (3-digit customer-facing), prefixed `K` for kiosk and `S` for
> mobile self-order. Client-generated (negative/temporary) values are replaced on first sync.

### `pos_presets`
Order mode profile: Dine-in / Takeaway / Delivery / Members. Drives pricelist, fiscal position,
required customer info and time-slot booking.
Maps from `pos.preset` (+ `pos_restaurant.use_guest`, `pos_self_order` fields).
Dropped: `resource.calendar` (→ `preset_service_windows`), `count_linked_*` computed counters.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| pricelist_id | FK→pricelists.id nullable, set null | |
| fiscal_position_id | FK→fiscal_positions.id nullable, set null | |
| identification | enum('none','name','address') default 'none' | required customer info |
| is_return | boolean default false | negative-qty return mode |
| use_guest | boolean default false | force guest-count prompt |
| color | unsignedTinyInteger default 0 | |
| image_media_id | FK→media_files.id nullable, set null | |
| sequence | integer default 10 | |
| use_timing | boolean default false | time-slot booking |
| slots_per_interval | unsignedSmallInteger default 5 | capacity per slot |
| interval_minutes | unsignedSmallInteger default 20 | slot width |
| available_in_self | boolean default false, index | shown in QR/kiosk |
| service_at | enum('counter','table','delivery') default 'counter' | |
| notification_template_id | FK→notification_templates.id nullable, set null | confirmation email per preset |
| is_system | boolean default false | the 3 seeded presets cannot be deleted |
| active | boolean default true, index | |
| timestamps | | |

### `preset_service_windows`
Opening hours per preset (replaces `resource.calendar.attendance`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_preset_id | FK→pos_presets.id, cascade | |
| day_of_week | unsignedTinyInteger | 0=Monday … 6=Sunday |
| hour_from | decimal(5,2) | 0–24; CHECK `hour_from < hour_to` |
| hour_to | decimal(5,2) | |
| day_period | enum('morning','afternoon','evening') nullable | display only |
| timestamps | | |
| index | (pos_preset_id, day_of_week) | |

### `pos_notes`
Predefined quick note chips for order lines / orders.
Maps from `pos.note`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | unique(company_id, name) |
| color | unsignedTinyInteger default 0 | |
| note_scope | enum('line','order','both') default 'line' | new: Odoo reused one pool for both |
| sequence | integer default 1 | |
| active | boolean default true | |
| timestamps | | |

### `pos_bills`
Cash denominations for opening/closing counts. Maps from `pos.bill`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| currency_id | FK→currencies.id, restrict | |
| name | string(32) | "50 €" |
| value | decimal(16,4) | |
| denomination_type | enum('bill','coin') default 'bill' | |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |
| index | (company_id, currency_id, value) | |

### `pos_printers`
Preparation (kitchen/bar) printers with POS-category routing.
Maps from `pos.printer`. Kept as-is; added `is_receipt_printer` so the same table can also describe
the customer-receipt printer of a kiosk.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| printer_type | enum('iot','epson_epos','network_escpos','browser') default 'epson_epos' | |
| proxy_ip | string(64) nullable | IoT box address |
| printer_ip | string(128) nullable | Epson/network address (required unless `iot`/`browser`) |
| printer_port | unsignedSmallInteger nullable | |
| serial_number | string(64) nullable | used to derive the Epson certified domain |
| profile | string(32) nullable | ESC/POS dialect (`generic`, `epson-tm-t20`, `epson-tm-t88`, `star-tsp100`, `bixolon-srp350`); null ⇒ `generic` |
| epos_device_id | string(32) nullable | Epson ePOS `devid`; null ⇒ `local_printer`. A multi-port TM-i exposes `local_printer2` and up |
| is_receipt_printer | boolean default false | prints customer receipts, not prep tickets |
| print_all_categories | boolean default false | true ⇒ ignore the category pivot, print everything |
| characters_per_line | unsignedTinyInteger default 42 | ticket layout |
| copies | unsignedTinyInteger default 1 | |
| sequence | unsignedSmallInteger default 0 | display and print order |
| active | boolean default true, index | |
| timestamps | | |

**Register payload (BAN-426).** `PosPrinter::toPosRow()` renames and derives these columns into the
field names `packages/domain` `PosPrinterRow` declares, because the two shapes had never met: the
row shipped `printer_ip` / `is_receipt_printer` and the register read `address` / `print_receipt`,
so every field it read was `undefined` — a receipt printer was classified `prep`, `categoryIds` was
`undefined`, and prep routing threw a `TypeError` on the first course of the shift.

| Shipped as | Derived from | Note |
|---|---|---|
| `address` | `proxy_ip` (iot) \| `printer_ip[:printer_port]` (epson/network) \| null (browser) | one address per transport; the source columns are **not** shipped |
| `print_receipt` | `is_receipt_printer` | decides `role`: `receipt` or `prep` |
| `pos_category_ids` | `pos_category_pos_printer` pivot | appended off an eager load; prep routing has nothing to match on without it |
| `print_all_categories` | as-is | **not** the same as an empty `pos_category_ids`, which marks the "everything else" fallback used only when nothing matched |

Asserted on both sides against `tests/fixtures/printing/printer-binding.json` —
`BootstrapContractTest` (h) for the payload, `resources/js/register/domain/printing.test.ts` for the
binding and the routing.

### `pos_category_pos_printer` (pivot)
Category routing. `pos_printer_id` FK cascade U, `pos_category_id` FK cascade U.
Maps from `pos.printer.product_categories_ids`.

### `payment_methods`
How money is taken. Maps from `pos.payment.method` (+ `pos_online_payment`).
Dropped: `journal_id`, `outstanding_account_id`, `receivable_account_id` (accounting). Replaced by
an explicit `method_type` and a free-form `ledger_code` used by the accounting export.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| method_type | enum('cash','bank','card_terminal','qr_code','online','customer_account','voucher') default 'bank', index | see §4.5 |
| is_cash_count | boolean default false, index | included in the cash drawer count (`method_type='cash'`) |
| currency_id | FK→currencies.id, restrict | must equal the config currency |
| identify_customer | boolean default false | `split_transactions` — forces a customer, exports one AR row per order |
| allow_change | boolean default false | can give change back (cash only, normally) |
| allow_refund | boolean default true | |
| is_rounding_target | boolean default false | cash rounding applied when this method is used |
| terminal_provider | enum('none','adyen','stripe','viva','razorpay','mercado_pago','pine_labs','qfpay','six','other') default 'none' | |
| terminal_config | json nullable | credentials/terminal ids (encrypted cast) |
| qr_code_method | enum('none','emv','sepa','swiss','pix','upi','promptpay') default 'none' | |
| default_qr_payload | text nullable | pre-generated amount-less QR (offline use) |
| payment_provider_id | FK→payment_providers.id nullable, restrict | online payments |
| ledger_code | string(32) nullable | free-text key echoed into the accounting export |
| image_media_id | FK→media_files.id nullable, set null | button icon |
| sequence | integer default 10, index | |
| active | boolean default true, index | |
| timestamps | | |

**Guards:** immutable (except `sequence`, `image`) while an open session uses it; a `cash` method
may be linked to **exactly one** `pos_config` (single drawer); at most **one** `online` method per
config.

### `payment_providers`
Online payment gateway. Maps from `payment.provider`. Dropped: the whole Odoo payment-acquirer
framework (tokenization, express checkout, onboarding) — kept the minimum for hosted redirect /
QR flows.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| code | enum('stripe','adyen','paypal','mollie','razorpay','flutterwave','aps','custom') | |
| state | enum('disabled','test','enabled') default 'disabled', index | |
| credentials | json nullable | encrypted cast |
| requires_customer_email | boolean default false | Odoo `_customer_required` (aps, flutterwave) |
| supported_currencies | json nullable | array of currency codes |
| sequence | integer default 10 | |
| timestamps | | |

### `notification_templates`
Email/SMS bodies (receipt, self-order confirmation, gift-card delivery).
Maps from `mail.template` + `sms.template`. Dropped: Odoo's template engine, server actions,
`mail.thread` delivery tracking (delivery is a queued job with a `notification_logs` row —
see Audit).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(96) | |
| channel | enum('email','sms') default 'email', index | |
| purpose | enum('receipt','self_order_confirmation','preset_confirmation','gift_card','loyalty','invoice') , index | |
| subject | string(255) nullable | email only |
| body | text | Blade-ish placeholder syntax `{{ order.tracking_number }}` |
| attach_receipt_image | boolean default false | |
| attach_invoice_pdf | boolean default false | |
| language_id | FK→languages.id nullable, set null | one row per language |
| active | boolean default true | |
| timestamps | | |

### `settings`
Global key/value replacing `ir.config_parameter`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id nullable, cascade | NULL = instance-wide |
| key | string(96) | unique(company_id, key) |
| value | text nullable | |
| value_type | enum('string','int','float','bool','json') default 'string' | |
| timestamps | | |

Seeded keys: `pos.limited_product_count` (5000), `pos.limited_customer_count` (100),
`pos.log_order_payloads` (false), `pos.printer_local_network_access` (false),
`pos.sync_retention_days` (30), `pos.receipt_portal_base_url`.

---

## 2.E Sessions & cash

### `pos_sessions`
A cashier work period on one register: the container for orders, cash and the closing figures.
Maps from `pos.session`. Dropped: `move_id` (closing journal entry), `bank_payment_ids`,
`statement_line_ids` (→ `cash_movements`), `picking_ids`, `update_stock_at_closing`,
`cash_journal_id`, mail activities. Kept: full state machine, opening/closing cash, rescue
sessions, notes, theoretical-vs-counted arithmetic.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_config_id | FK→pos_configs.id, restrict, index | |
| company_id | FK→companies.id, cascade | denormalised |
| currency_id | FK→currencies.id, restrict | frozen from config at open |
| name | string(48), index | `SHOP/00042`, from `sequences.purpose='session'` |
| state | enum('opening_control','opened','closing_control','closed') default 'opening_control', index | §4.2 |
| opened_by_user_id | FK→users.id nullable, restrict | |
| opened_by_employee_id | FK→employees.id nullable, restrict | |
| closed_by_user_id | FK→users.id nullable, restrict | |
| closed_by_employee_id | FK→employees.id nullable, restrict | |
| opened_at | timestamp nullable, index | `start_at` |
| closed_at | timestamp nullable, index | `stop_at` |
| business_date | date, index | logical trading day (handles past-midnight service) |
| opening_notes | text nullable | |
| closing_notes | text nullable | |
| has_cash_control | boolean default false | frozen from config |
| cash_balance_opening | decimal(16,4) default 0 | counted float at open |
| cash_balance_opening_expected | decimal(16,4) default 0 | previous session's counted close |
| cash_balance_closing_counted | decimal(16,4) nullable | counted at close |
| cash_balance_closing_expected | decimal(16,4) default 0 | opening + cash payments + cash in/out − change given |
| cash_difference | decimal(16,4) default 0 | counted − expected (stored, not computed, so it survives later edits) |
| cash_in_total | decimal(16,4) default 0 | Σ positive `cash_movements` |
| cash_out_total | decimal(16,4) default 0 | Σ negative `cash_movements` |
| order_count | unsignedInteger default 0 | denormalised |
| order_amount_total | decimal(16,4) default 0 | denormalised (paid orders) |
| refund_amount_total | decimal(16,4) default 0 | |
| payments_total | decimal(16,4) default 0 | Σ captured payments |
| rounding_total | decimal(16,4) default 0 | Σ `pos_orders.amount_rounding`; frozen at close so the export's imbalance check never reads live orders |
| write_off_total | decimal(16,4) default 0 | Σ `pos_orders.amount_write_off`; frozen at close for the same reason. Kept apart from `rounding_total` so each concession stays separately answerable |
| is_rescue | boolean default false, index | auto-created recovery session for late offline pushes |
| rescued_from_session_id | FK→pos_sessions.id nullable, set null | |
| closing_forced | boolean default false | manager forced the close over an unauthorised difference |
| closing_force_reason | string(255) nullable | |
| accounting_exported_at | timestamp nullable, index | |
| timestamps | | |
| index | (pos_config_id, state) | dashboard "current session" lookup |
| unique index (partial) | (pos_config_id) WHERE state <> 'closed' AND is_rescue = false | **enforces one open session per register** (Postgres partial unique; on MySQL use a generated `open_session_key` column = `pos_config_id` when open else NULL, with a unique index) |

### `cash_movements`
Every non-order movement of physical cash + the reconciliation artefacts of the close.
Maps from `account.bank.statement.line` with `pos_session_id`. Dropped: journal, statement,
reconciliation, foreign currency.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | client-created (cash in/out happens offline) |
| pos_session_id | FK→pos_sessions.id, cascade, index | |
| company_id | FK→companies.id, cascade | |
| movement_type | enum('cash_in','cash_out','opening_float','closing_lift','difference') default 'cash_in', index | §4.4 |
| amount | decimal(16,4) | **signed**: in = +, out = − |
| reason | string(255) nullable | free text ("bank drop", "supplier") |
| customer_id | FK→customers.id nullable, set null | partner attribution (Odoo allowed it) |
| employee_id | FK→employees.id nullable, set null | who did it |
| user_id | FK→users.id nullable, set null | |
| pos_device_id | FK→pos_devices.id nullable, set null | which till drawer |
| moved_at | timestamp(3), index | |
| timestamps, softDeletes | | soft-deleted (Odoo `delete_cash_in_out` logs the deletion) |
| index | (pos_session_id, movement_type) | |

### `session_events`
What happened to this till, in order (REG-024). `audit_logs` covers orders and `cash_movements`
covers money; neither answers "what happened to this session yesterday", and reconstructing it from
a state column and three other tables is guesswork. Append-only: no update path, no soft delete —
its value is that it says what happened, not what is currently true.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_session_id | FK→pos_sessions.id, cascade, index | |
| company_id | FK→companies.id, cascade | |
| event_type | enum('opened','opening_control_confirmed','cash_in','cash_out','x_report','closed','force_closed','rescued'), index | §4.4 |
| payload | json nullable | whatever makes the row readable a month later: the float declared, the difference forced over, the figures a reading showed |
| employee_id | FK→employees.id nullable, set null | |
| user_id | FK→users.id nullable, set null | |
| pos_device_id | FK→pos_devices.id nullable, set null | |
| occurred_at | timestamp(3), index | |
| timestamps | | |
| index | (pos_session_id, occurred_at) | the shift is always read in order, for one session |

**Exactly one row per lifecycle transition**, and the guarantee lives in `SessionEventRecorder`
rather than in each caller: `close()` runs in a transaction that can be retried, and an order push
can reroute into a rescue session more than once. `x_report`, `cash_in` and `cash_out` are the
exception and append every time — two readings are two readings, and a drawer opened four times in
an hour is the pattern the log exists to show.

`closed` and `force_closed` are mutually exclusive; a forced close is the close.

### `session_cash_counts`
A denomination count event (opening or closing). One header per count.
New table (Odoo kept only the total). Enables a real "count the drawer" UX and a variance audit.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_session_id | FK→pos_sessions.id, cascade | |
| count_type | enum('opening','closing','mid_shift') default 'opening' | |
| total_counted | decimal(16,4) default 0 | Σ of lines (validated against the entered total) |
| counted_by_employee_id | FK→employees.id nullable, set null | |
| counted_at | timestamp(3) | |
| notes | text nullable | |
| timestamps | | |
| index | (pos_session_id, count_type) | |

### `session_cash_count_lines`
| Column | Type | Notes |
|---|---|---|
| id | id | |
| session_cash_count_id | FK→session_cash_counts.id, cascade | |
| pos_bill_id | FK→pos_bills.id nullable, set null | NULL for a free-form amount |
| denomination_value | decimal(16,4) | frozen copy of `pos_bills.value` |
| quantity | unsignedInteger default 0 | |
| subtotal | decimal(16,4) | value × quantity |
| timestamps | | |

### `session_payment_totals`
Per-session × payment-method closing figures — expected, counted, difference. This is what the
closing popup writes and what the accounting export reads.
Maps from `pos.session.get_closing_control_data` output + `bank_payment_method_diffs`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_session_id | FK→pos_sessions.id, cascade | unique(pos_session_id, payment_method_id) |
| payment_method_id | FK→payment_methods.id, restrict | |
| currency_id | FK→currencies.id, restrict | |
| expected_amount | decimal(16,4) default 0 | Σ of `pos_payments` for this method (incl. change) |
| counted_amount | decimal(16,4) nullable | keyed in at close (cash: from the count; card: from the terminal batch) |
| difference_amount | decimal(16,4) default 0 | counted − expected |
| payment_count | unsignedInteger default 0 | |
| refund_amount | decimal(16,4) default 0 | Σ of negative payments (excluding change) |
| change_amount | decimal(16,4) default 0 | Σ of `is_change` payments |
| ledger_code | string(32) nullable | frozen copy of `payment_methods.ledger_code` |
| timestamps | | |

### `session_sales_summaries`
Frozen revenue breakdown of a closed session — the sales half of the accounting export.
Maps from `pos.session._accumulate_amounts` sales lines (+ `is_closing_entry_by_product`).
Dropped: income accounts, tax tags, repartition lines.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_session_id | FK→pos_sessions.id, cascade | |
| pos_category_id | FK→pos_categories.id nullable, set null | primary POS category at time of sale |
| product_id | FK→products.id nullable, set null | populated only when the config breaks down per product |
| tax_signature | string(64), index | stable hash of the sorted applied tax-id set (groups identical tax combos) |
| is_refund | boolean default false, index | refund rows kept separate |
| quantity | decimal(16,3) default 0 | |
| base_amount | decimal(16,4) default 0 | tax-excluded net (after discounts) |
| discount_amount | decimal(16,4) default 0 | |
| tax_amount | decimal(16,4) default 0 | |
| total_amount | decimal(16,4) default 0 | base + tax |
| cost_amount | decimal(16,4) default 0 | Σ line costs (margin reporting) |
| ledger_code | string(32) nullable | revenue account/code hint for the export |
| timestamps | | |
| index | (pos_session_id, is_refund) | |

### `session_tax_summaries`
Per-tax base/amount for the session (the tax half of the export + the Sales Details report).
Maps from `_accumulate_amounts` tax lines.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_session_id | FK→pos_sessions.id, cascade | |
| tax_id | FK→taxes.id, restrict | unique(pos_session_id, tax_id, is_refund) |
| tax_group_id | FK→tax_groups.id, restrict | |
| is_refund | boolean default false | |
| base_amount | decimal(16,4) default 0 | |
| tax_amount | decimal(16,4) default 0 | |
| tax_rate | decimal(9,4) | frozen rate at close |
| timestamps | | |

### `accounting_exports`
A batch that turns N closed sessions into a file / API push for the external ledger.
New table (replaces Odoo's closing journal entry + `pos.close.session.wizard`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| period_start, period_end | date | |
| format | enum('csv','json','xlsx','api') default 'csv' | |
| state | enum('draft','generated','exported','sent','failed') default 'draft', index | `exported` is the commit point — file written, pivot rows in, sessions marked |
| session_count | unsignedInteger default 0 | |
| total_sales | decimal(16,4) default 0 | |
| total_tax | decimal(16,4) default 0 | |
| total_payments | decimal(16,4) default 0 | |
| total_rounding | decimal(16,4) default 0 | Σ `pos_sessions.rounding_total` over the period |
| total_write_off | decimal(16,4) default 0 | Σ `pos_sessions.write_off_total`; without it a period containing a stale-price sale does not add up on its face |
| imbalance_amount | decimal(16,4) default 0 | sales+tax+rounding−write_off−payments; non-zero triggers the "force balance" UI |
| media_file_id | FK→media_files.id nullable, set null | generated file; served only by the authenticated download route, never web-served |
| generated_by_user_id | FK→users.id nullable, set null | |
| error_message | text nullable | |
| timestamps | | |

### `accounting_export_session` (pivot)
`accounting_export_id` FK cascade U, `pos_session_id` FK cascade U.
**unique(`pos_session_id`)** — `accounting_export_session_once`.

**This pivot is the double-counting guard, not bookkeeping.** A session is exported exactly once:
the build excludes any session already joined to an export in state `exported` or `sent`, and the
whole build (row, pivot, file, session marking) commits in one transaction. A failed build releases
its sessions rather than stranding them.

The read-back alone is a check-then-act, so it is *not* the guarantee — two operators exporting the
same period at once would both see the session as unclaimed and both commit, since their exports
have different ids and the composite primary key admits both rows. The **unique index on
`pos_session_id`** is what makes "at most one export" true. It is sound precisely because a
rolled-back build leaves no pivot rows: every row here belongs to a committed export.

---

## 2.F Orders

### `pos_orders`
The central document. **uuid-first**: the client mints the uuid, the server never re-issues it, and
`sync` is a pure upsert keyed on it.
Maps from `pos.order` (+ restaurant, self-order, hr, loyalty extensions). Dropped: `account_move`
(→ `pos_invoices`), `session_move_id`, `reversed_move_ids`, `sale_journal`, `picking_ids`,
`picking_type_id`, `stock_reference_ids`, `shipping_date`, `currency_rate` kept, `to_invoice`
kept, portal mixin (kept `access_token` + `ticket_code`).

**Identity & routing**
| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | **idempotency key for sync** |
| pos_session_id | FK→pos_sessions.id, restrict, index | may be re-pointed on late sync (rescue) |
| pos_config_id | FK→pos_configs.id, restrict, index | denormalised (survives session moves) |
| company_id | FK→companies.id, cascade | |
| pos_device_id | FK→pos_devices.id nullable, set null | which register created it |
| name | string(64) nullable, index | display ref, assigned when the order is paid (`SHOP/00042`; refunds `… REFUND`) |
| receipt_number | string(48) nullable, index | `YY{device}-{config}-{seq}` |
| tracking_number | string(12) nullable, index | short customer-facing number (`seq % 1000`, `K`/`S` prefixed for kiosk/mobile) |
| sequence_number | integer nullable | session-scoped counter (negative while client-generated) |
| access_token | char(36), index | per-order capability token (self-order tracking, online payment, receipt portal) |
| ticket_code | char(5) nullable, index | portal invoice self-service code |
| source | enum('pos','mobile','kiosk','backoffice','api') default 'pos', index | §4.7 |

**Business**
| Column | Type | Notes |
|---|---|---|
| state | enum('draft','paid','done','cancelled') default 'draft', index | §4.1 |
| ordered_at | timestamp(3), index | `date_order`; client clock, server-corrected on first sync |
| paid_at | timestamp(3) nullable, index | |
| closed_at | timestamp(3) nullable | state→done |
| cancelled_at | timestamp nullable | |
| cancel_reason | string(255) nullable | |
| customer_id | FK→customers.id nullable, set null, index | |
| employee_id | FK→employees.id nullable, set null, index | cashier |
| user_id | FK→users.id nullable, set null | back-office actor |
| pricelist_id | FK→pricelists.id nullable, restrict | |
| fiscal_position_id | FK→fiscal_positions.id nullable, restrict | |
| pos_preset_id | FK→pos_presets.id nullable, restrict | |
| preset_time | timestamp nullable, index | booked pickup/delivery slot |
| currency_id | FK→currencies.id, restrict | |
| currency_rate | decimal(24,12) default 1 | frozen company↔order rate |
| floating_order_name | string(96) nullable | parked/named order label ("Direct Sale", "John's tab") |

**Amounts** (all server-recomputed; the client is never trusted)
| Column | Type | Notes |
|---|---|---|
| amount_untaxed | decimal(16,4) default 0 | |
| amount_tax | decimal(16,4) default 0 | |
| amount_total | decimal(16,4) default 0, index | tax-included grand total, after cash rounding |
| amount_rounding | decimal(16,4) default 0 | cash-rounding adjustment |
| amount_paid | decimal(16,4) default 0 | Σ payments (incl. negative change) |
| amount_change | decimal(16,4) default 0 | change given back |
| amount_due | decimal(16,4) default 0 | total − paid − write_off (0 when settled) |
| amount_write_off | decimal(16,4) default 0 | money a settled sale was short and will never collect: the server repriced above what the till had already taken. Capped at the server's own repricing delta (never at the device-declared total), cumulatively, so a genuine part-payment keeps its `amount_due` |
| amount_discount | decimal(16,4) default 0 | Σ of line discounts (reporting) |
| total_cost | decimal(16,4) default 0 | Σ line costs |
| margin | decimal(16,4) default 0 | |
| margin_percent | decimal(9,4) default 0 | |
| tax_details | json nullable | frozen per-tax `[{tax_id,name,rate,base,amount,group_id}]` for receipt re-render |

**Restaurant**
| Column | Type | Notes |
|---|---|---|
| restaurant_table_id | FK→restaurant_tables.id nullable, set null, index | |
| guest_count | unsignedSmallInteger default 0 | `customer_count` |
| is_tipped | boolean default false | |
| tip_amount | decimal(16,4) default 0 | |
| split_from_order_id | FK→pos_orders.id nullable, set null | the order this split bill came from |
| split_letter | char(1) nullable | `B`, `C` … suffix (max 26 parts) |
| merged_into_order_id | FK→pos_orders.id nullable, set null | set when this order was merged away (kept for audit, `deleted_at` set) |

**Refund / invoice**
| Column | Type | Notes |
|---|---|---|
| is_refund | boolean default false, index | |
| refunded_order_id | FK→pos_orders.id nullable, set null, index | the original order (a refund may reference exactly one) |
| refund_count | unsignedSmallInteger default 0 | denormalised: how many refunds exist against this order |
| has_refundable_lines | boolean default true | denormalised guard for the "Return Products" button |
| to_invoice | boolean default false, index | customer asked for an invoice |
| pos_invoice_id | FK→pos_invoices.id nullable, set null | |

**Kitchen & notes**
| Column | Type | Notes |
|---|---|---|
| general_customer_note | text nullable | prints on receipt + kitchen header |
| internal_note | text nullable | kitchen-only |
| prep_state | enum('none','pending','sent','partially_ready','ready','served') default 'none', index | derived from `prep_orders`; denormalised for the floor screen badge |
| unsent_change_count | unsignedSmallInteger default 0 | denormalised badge counter (Odoo computed it client-side) |
| last_prep_sent_at | timestamp(3) nullable | |

**Self-order**
| Column | Type | Notes |
|---|---|---|
| self_order_table_id | FK→restaurant_tables.id nullable, set null | table whose QR was scanned (may differ from `restaurant_table_id`) |
| table_stand_number | string(16) nullable | kiosk table-tracker number |
| customer_email | string(160) nullable | receipt destination (defaults from customer) |
| customer_phone | string(40) nullable | SMS receipt |
| use_self_online_payment | boolean default false | self-order online flow vs cashier QR flow |

**Audit / print**
| Column | Type | Notes |
|---|---|---|
| print_count | unsignedSmallInteger default 0 | `nb_print`; >0 freezes payments |
| is_edited | boolean default false, index | a line was modified after being sent |
| has_deleted_line | boolean default false | |
| client_created_at | timestamp(3) nullable | client clock at creation (drift analysis) |
| synced_at | timestamp(3) nullable, index | server clock at last successful sync |
| ui_state | json nullable | opaque client state (split bookkeeping, last prints, unmerge data) |
| timestamps, softDeletes | | |

**Indexes**
| Index | Purpose |
|---|---|
| unique (uuid) | idempotent sync |
| (pos_config_id, state, deleted_at) | open/parked order bootstrap |
| (pos_session_id, state) | session close guards, totals |
| (restaurant_table_id, state) | one draft order per table |
| (pos_config_id, ordered_at desc) | ticket screen paging |
| (company_id, updated_at) | incremental delta sync |
| (access_token) | self-order/portal lookups |
| (receipt_number) | portal invoice request |

**Preserved invariants (application layer):**
- One **draft** order per `restaurant_table_id` per config (Odoo `_get_open_order` override).
- A non-draft order can never return to `draft`.
- Payments cannot change once `print_count > 0`.
- `amount_paid` must cover `amount_total` within the cash-rounding tolerance
  (half-up: ±rounding/2, else ±rounding).
- A refund order references exactly one `refunded_order_id`.
- Late sync into a closed session ⇒ reroute to any open session of the same config, else create a
  `is_rescue` session.

### `pos_order_lines`
Maps from `pos.order.line`. Dropped: `pack_lot_ids`, `total_cost` valuation layers (kept a simple
`unit_cost`), `extra_tax_data` (→ `tax_details`), `product_uom_id` (kept), `name` line sequence
(kept as `line_number`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | line-level idempotency |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| company_id | FK→companies.id, cascade | denormalised for reporting |
| line_number | unsignedInteger nullable | display/print order within the order |
| product_variant_id | FK→product_variants.id, restrict, index | |
| product_id | FK→products.id, restrict, index | denormalised (reporting + prep routing) |
| pos_category_id | FK→pos_categories.id nullable, set null, index | **frozen** primary category — kitchen routing must not change if the product is recategorised later |
| full_product_name | string(255) | frozen display name incl. attributes |
| uom_id | FK→uoms.id, restrict | |
| quantity | decimal(16,3) default 1 | negative for refunds/returns |
| price_unit | decimal(16,4) default 0 | pre-discount, pre-tax-inclusion unit price |
| price_extra | decimal(16,4) default 0 | Σ attribute price extras |
| price_type | enum('original','manual','automatic') default 'original' | how the price got set |
| discount_percent | decimal(9,4) default 0 | |
| discount_amount | decimal(16,4) default 0 | absolute discount (denormalised) |
| discount_notice | string(96) nullable | `notice` |
| price_subtotal | decimal(16,4) default 0 | tax-excluded |
| price_subtotal_incl | decimal(16,4) default 0 | tax-included |
| tax_details | json nullable | frozen `[{tax_id,name,rate,amount,base,price_include}]` |
| tax_signature | string(64), index | hash of applied tax ids (session summary grouping) |
| unit_cost | decimal(16,4) default 0 | |
| total_cost | decimal(16,4) default 0 | |
| margin | decimal(16,4) default 0 | |
| customer_note | string(255) nullable | prints on receipt + kitchen |
| internal_note | json nullable | array of `{text, color_index}` chips (Odoo stored this as a JSON string) |
| combo_parent_line_id | FK→pos_order_lines.id nullable, cascade, index | combo child → parent |
| combo_id | FK→combos.id nullable, set null | which choice group this child came from |
| combo_item_id | FK→combo_items.id nullable, set null | |
| restaurant_course_id | FK→restaurant_order_courses.id nullable, set null, index | |
| refunded_order_line_id | FK→pos_order_lines.id nullable, set null, index | |
| refunded_quantity | decimal(16,3) default 0 | Σ of qty already refunded from this line |
| is_reward_line | boolean default false, index | loyalty |
| loyalty_reward_id | FK→loyalty_rewards.id nullable, set null | |
| loyalty_card_id | FK→loyalty_cards.id nullable, set null | |
| reward_identifier_code | string(48) nullable, index | groups the lines produced by one reward claim |
| points_cost | decimal(16,3) default 0 | |
| is_edited | boolean default false | audit |
| skip_preparation | boolean default false | never routed to kitchen (e.g. tips, discounts) |
| ui_state | json nullable | split quantities, client-only flags |
| timestamps, softDeletes | | |
| index | (pos_order_id, line_number) | |
| index | (product_variant_id, created_at) | product sales reporting |

### `pos_order_line_attribute_value` (pivot)
Selected `no_variant` attribute values riding on the line.
Maps from `pos.order.line.attribute_value_ids`.

| Column | Type | Notes |
|---|---|---|
| pos_order_line_id | FK→pos_order_lines.id, cascade | U |
| product_attribute_line_value_id | FK→product_attribute_line_values.id, restrict | U |
| price_extra | decimal(16,4) default 0 | frozen copy at sale time |

### `pos_order_line_custom_attribute_values`
Free-text values for `is_custom` attribute values.
Maps from `product.attribute.custom.value`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_order_line_id | FK→pos_order_lines.id, cascade | |
| product_attribute_line_value_id | FK→product_attribute_line_values.id, restrict | |
| custom_value | string(255) | |
| timestamps | | |

### `pos_payments`
Maps from `pos.payment`. Dropped: `account_move_id`, `online_account_payment_id` (→
`payment_transactions`), accounting partner resolution.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| pos_session_id | FK→pos_sessions.id, restrict, index | denormalised (closing totals) |
| payment_method_id | FK→payment_methods.id, restrict, index | must be enabled on the order's config |
| company_id | FK→companies.id, cascade | |
| currency_id | FK→currencies.id, restrict | |
| amount | decimal(16,4) | **negative = change or refund** |
| amount_company_currency | decimal(16,4) | converted with `pos_orders.currency_rate` |
| is_change | boolean default false, index | change handed back (always cash) |
| is_refund | boolean default false | |
| label | string(96) nullable | `name` ("return", "tip adjustment") |
| paid_at | timestamp(3), index | |
| customer_id | FK→customers.id nullable, set null | required when the method has `identify_customer` |
| employee_id | FK→employees.id nullable, set null | |
| pos_device_id | FK→pos_devices.id nullable, set null | |
| payment_status | enum('pending','authorized','done','reversed','failed','cancelled') default 'done', index | §4.6 |
| **Terminal metadata** | | |
| card_type | string(32) nullable | |
| card_brand | string(32) nullable | |
| card_last4 | char(4) nullable | never store a full PAN |
| cardholder_name | string(96) nullable | |
| auth_code | string(32) nullable | |
| transaction_reference | string(96) nullable, index | terminal/gateway id |
| issuer_bank | string(64) nullable | |
| entry_mode | string(24) nullable | chip / contactless / swipe / manual |
| terminal_payload | json nullable | raw terminal response (encrypted cast) |
| terminal_ticket | text nullable | merchant slip to reprint |
| payment_transaction_id | FK→payment_transactions.id nullable, set null | online payments |
| timestamps, softDeletes | | |
| index | (pos_session_id, payment_method_id) | closing totals |

**Invariants:** payments of an order that is `done`/invoiced/printed are immutable; the payment
method must belong to the order's config; a change line is always negative and always cash.

### `customer_account_moves`
The immutable ledger behind a customer's running tab (REG-208, BOF-119). Deliberately **not** an ERP
receivable — no ageing, no dunning, no payment terms (see 02-features §"Payment terms, partner
receivable/payable ledgers"). Modelled on `loyalty_card_histories`: `balance_after` is stored rather
than derived so a statement prints without replaying the table.

Lives in the order domain rather than identity because it points at `pos_payments`, and identity
migrates first — the FK direction places it, not the subject matter.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| customer_id | FK→customers.id, restrict | |
| move_type | enum('charge','settlement') default 'charge', index | §4.x. There is deliberately no `reversal` — see invariants |
| amount | decimal(16,4) | **signed**, positive = the customer owes more. A charge is positive, a settlement negative, and the balance is the plain sum of this column |
| balance_after | decimal(16,4) | running total at this row |
| pos_order_id | FK→pos_orders.id nullable, set null | |
| pos_payment_id | FK→pos_payments.id nullable, **unique**, set null | one move per payment. NULL for settlements, and repeated NULLs are permitted by every engine we target |
| payment_method_id | FK→payment_methods.id nullable, set null | how a settlement was taken; null on a charge |
| pos_session_id | FK→pos_sessions.id nullable, set null | |
| employee_id | FK→employees.id nullable, set null | |
| user_id | FK→users.id nullable, set null | |
| description | string(160) nullable | |
| occurred_at | timestamp(3), index | |
| timestamps | | |

Index: (`customer_id`, `occurred_at`) for the statement view.

**Invariants:** append-only — no update path, no soft delete. `customers.account_balance` =
Σ`amount` for that customer. **One move per payment**, enforced by the unique index rather than by a
service that remembers to check: `POST /api/pos/sync` is a pure upsert and the register retries, so
the same pay-later payment arrives repeatedly by design. A charge is booked **only for a settled
order** (`paid`/`done`), which is also why no `reversal` type exists: settled orders' payments are
immutable (§ settled-order rules), so a booked charge can never need undoing, and a returned sale
comes back as a refund order whose on-account payment is negative.

### `payment_transactions`
Online payment attempt (customer's phone, kiosk QR, or cashier-presented QR).
Maps from `payment.transaction`. Dropped: tokenization, partner-side vault, refund chaining
(a refund creates a new transaction row).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| payment_provider_id | FK→payment_providers.id, restrict | |
| payment_method_id | FK→payment_methods.id, restrict | |
| reference | string(96) **unique** | gateway reference, prefixed with `receipt_number` |
| provider_reference | string(128) nullable, index | id at the PSP |
| amount | decimal(16,4) | |
| currency_id | FK→currencies.id, restrict | |
| state | enum('draft','pending','authorized','done','cancelled','error') default 'draft', index | §4.6 |
| state_message | text nullable | |
| customer_id | FK→customers.id nullable, set null | |
| payload | json nullable | request/response (encrypted cast) |
| initiated_at, completed_at | timestamp(3) nullable | |
| timestamps | | |

### `pos_invoices`
A lean, immutable customer invoice document (legal receipt upgrade). It is **not** a ledger entry —
it is a numbered PDF-able snapshot.
Maps from the `account.move` created by `_generate_pos_order_invoice`. Dropped: journal items,
reconciliation, payment terms, reversal entries, e-invoicing frameworks (hookable later).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| pos_order_id | FK→pos_orders.id, restrict, index | unique — one invoice per order |
| number | string(48) **unique** | from `sequences.purpose='invoice'` |
| invoice_type | enum('invoice','credit_note') default 'invoice' | credit note when the order is a refund |
| reversed_invoice_id | FK→pos_invoices.id nullable, set null | credit note → original |
| customer_id | FK→customers.id, restrict | required |
| customer_snapshot | json | frozen name/address/VAT at issue time |
| issued_at | timestamp, index | |
| currency_id | FK→currencies.id, restrict | |
| amount_untaxed, amount_tax, amount_total | decimal(16,4) | |
| tax_details | json | frozen per-tax breakdown |
| pdf_media_id | FK→media_files.id nullable, set null | |
| sent_at | timestamp nullable | emailed to the customer |
| state | enum('draft','issued','sent','cancelled') default 'issued', index | |
| timestamps | | |

### `pos_invoice_lines`
Frozen line snapshot so the invoice PDF is reproducible even if the order is later refunded.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_invoice_id | FK→pos_invoices.id, cascade | |
| pos_order_line_id | FK→pos_order_lines.id nullable, set null | provenance |
| line_type | enum('product','section','note','rounding','discount') default 'product' | combo parents become sections; notes become note lines |
| description | string(255) | |
| quantity | decimal(16,3) default 1 | |
| price_unit | decimal(16,4) default 0 | |
| discount_percent | decimal(9,4) default 0 | |
| price_subtotal | decimal(16,4) default 0 | |
| price_subtotal_incl | decimal(16,4) default 0 | |
| tax_details | json nullable | |
| sort_order | unsignedSmallInteger default 0 | |
| timestamps | | |

---

## 2.G Restaurant

### `restaurant_floors`
Maps from `restaurant.floor`. Dropped: the legacy `background_image` binary duplicate.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | floors can be created from the register's edit mode |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| background_color | string(24) nullable | palette key (`white`,`red`,…) resolved client-side to light/dark RGB |
| background_media_id | FK→media_files.id nullable, set null | uploaded floor plan image |
| sequence | integer default 1, index | tab order |
| table_count | unsignedSmallInteger default 0 | denormalised |
| active | boolean default true, index | soft delete ("deactivate floor") |
| timestamps, softDeletes | | |

**Guards:** cannot deactivate/delete (or unlink from a config) while a linked config has an open
session or the floor's tables carry draft orders.

### `restaurant_tables`
Maps from `restaurant.table` (+ `pos_self_order.identifier`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| restaurant_floor_id | FK→restaurant_floors.id, cascade, index | |
| company_id | FK→companies.id, cascade | denormalised |
| table_number | unsignedInteger default 0, index | displayed number; unique(restaurant_floor_id, table_number) among active rows |
| name | string(32) nullable | optional label ("Terrace 3") |
| identifier | char(8) **unique** | QR capability token; regenerated by "rotate access tokens" |
| shape | enum('square','round') default 'square' | |
| position_x | decimal(10,2) default 10 | px from left |
| position_y | decimal(10,2) default 10 | px from top |
| width | decimal(10,2) default 50 | |
| height | decimal(10,2) default 50 | |
| seats | unsignedSmallInteger default 2 | default guest count for a new order |
| color | string(24) nullable | any CSS background value; default `#35d374` |
| booked_at | timestamp nullable | **held for a booking** (RST-059). Null means free. A timestamp rather than a flag: "held since 19:40" is what decides whether a party is late, and a boolean throws that away. Set server-side so every till reads one clock; re-booking a held table does not move it. |
| booked_note | string(64) nullable | who the hold is for — a name off the booking sheet, not a customer record |
| parent_id | FK→restaurant_tables.id nullable, set null, index | **physical link/merge**: child snaps to parent, orders merge; cycle-guarded |
| active | boolean default true, index | soft delete |
| timestamps, softDeletes | | |

**Guards:** cannot delete while draft orders exist on it; cannot hard-delete while a config with an
open session uses its floor; `parent_id` chains must be acyclic.

A hold is **independent of occupancy**: a table can be booked and have a bill on it at the same time,
because a party finishing at 20:00 on a table booked for 20:30 is the ordinary case. Releasing a hold
touches no order.

### `restaurant_order_courses`
Maps from `restaurant.order.course` (new in Odoo 19, community).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | client-created |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| course_index | unsignedSmallInteger default 1, index | 1-based; re-indexed on cleanup |
| name | string(48) nullable | optional custom name ("Starters"); default "Course N" |
| fired | boolean default false, index | |
| fired_at | timestamp(3) nullable | stamped server-side when `fired` flips true |
| line_count | unsignedSmallInteger default 0 | denormalised |
| timestamps, softDeletes | | |
| unique | (pos_order_id, course_index) *(among non-deleted)* | |

**Rules preserved:** creating the first course while lines exist assigns all existing lines to
course 1 and opens an empty course 2; combo children inherit their parent's course; trailing empty
unfired courses are deleted and indexes compacted on leaving the product screen; `fired_at` is
immutable once set.

### `pos_order_merges`
Audit + restore payload for table linking, order transfer/merge and unmerge.
New table. Odoo kept this only in volatile client `uiState` (`unmerge`/`unmergeCourses`), which is
lost on device change — persisting it is a deliberate improvement and is required for
multi-device correctness.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| source_order_id | FK→pos_orders.id, cascade, index | the order that was absorbed (soft-deleted afterwards) |
| target_order_id | FK→pos_orders.id, cascade, index | the surviving order |
| source_table_id | FK→restaurant_tables.id nullable, set null | where to restore to on unmerge |
| merge_type | enum('table_link','order_transfer','order_merge','split') default 'order_merge' | |
| restore_payload | json | per-line `{line_uuid, quantity, former_order_uuid}` and per-course `{index, fired, fired_at, line_uuids}` |
| prep_history_payload | json nullable | migrated sent-quantities so the kitchen is not re-fired |
| performed_by_employee_id | FK→employees.id nullable, set null | |
| performed_at | timestamp(3) | |
| reverted_at | timestamp nullable | set when unmerged |
| timestamps | | |

---

## 2.H Kitchen — preparation display & printing

> Odoo Community has **printer-only** preparation (the KDS is enterprise). This spec implements
> **both**: the delta/printing engine at parity with community, *plus* a first-class KDS
> (`prep_*` tables) since the brief requires "kitchen preparation display + printing".

### `order_preparation_snapshots`
The baseline the delta engine diffs against ("what the kitchen already knows"). One row per order.
Maps from `pos.order.last_order_preparation_change` (a JSON blob). Kept as a separate row so it can
be locked/versioned independently of the order and does not bloat every order read.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| pos_order_id | FK→pos_orders.id, cascade | **unique** (1:1) |
| snapshot | json | `{ "<line_uuid>|<note_hash>": {uuid, name, basic_name, product_id, attribute_names, quantity, note, customer_note, pos_category_id, sequence, combo_parent_uuid, course_index} }` |
| general_customer_note | text nullable | note baseline |
| internal_note | text nullable | note baseline |
| server_version | unsignedInteger default 0 | **optimistic-lock counter**: a client submitting a stale version is told "Order Outdated" and must adopt the server snapshot (replaces Odoo's `metadata.serverDate` comparison) |
| server_date | timestamp(3) | wall-clock companion, kept for parity with existing clients |
| timestamps | | |

### `prep_displays`
A kitchen/bar screen. New (mirrors enterprise `pos.prep.display`).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| access_token | char(32) **unique** | broadcast channel + kiosk-style unauthenticated screen URL |
| layout | enum('columns','grid','list') default 'columns' | |
| auto_advance_on_all_ready | boolean default true | line → order state roll-up |
| show_all_categories | boolean default false | true ⇒ ignore category routing |
| average_prep_minutes | unsignedSmallInteger default 10 | drives the late/overdue colouring |
| late_threshold_minutes | unsignedSmallInteger default 15 | |
| done_retention_minutes | unsignedSmallInteger default 60 | how long completed orders stay visible/recallable |
| sound_on_new_order | boolean default true | |
| active | boolean default true, index | |
| timestamps | | |

### `pos_category_prep_display` (pivot)
`prep_display_id` FK cascade U, `pos_category_id` FK cascade U. Category routing (same semantics as
printer routing: a line goes to a display if its frozen `pos_category_id` is in the set, or the
display has `show_all_categories`).

### `prep_stages`
Columns/lanes of a display ("To Do" → "Cooking" → "Ready"). New.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| prep_display_id | FK→prep_displays.id, cascade | |
| name | string(48) | |
| stage_type | enum('todo','in_progress','ready','done') default 'todo', index | semantics for automation |
| color | string(24) nullable | |
| alert_after_minutes | unsignedSmallInteger nullable | turns the card orange/red |
| sequence | integer default 10, index | |
| is_default | boolean default false | landing stage for new lines |
| timestamps | | |
| unique | (prep_display_id, sequence) | |

### `prep_orders`
An order as seen by one display (an order visible on 2 displays has 2 rows).
New. This is the KDS work item.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| prep_display_id | FK→prep_displays.id, cascade, index | |
| pos_order_id | FK→pos_orders.id, cascade, index | unique(prep_display_id, pos_order_id) |
| pos_config_id | FK→pos_configs.id, restrict | denormalised for filtering |
| tracking_number | string(12) nullable, index | big number on the card |
| table_label | string(48) nullable | frozen "Floor - T12" |
| guest_count | unsignedSmallInteger default 0 | |
| preset_label | string(32) nullable | "Takeaway" / "Dine in" |
| customer_name | string(96) nullable | |
| order_note | text nullable | frozen order-level notes |
| state | enum('pending','in_progress','ready','served','cancelled') default 'pending', index | roll-up of its lines |
| fired_at | timestamp(3), index | when it hit the display |
| first_started_at | timestamp(3) nullable | |
| ready_at | timestamp(3) nullable | |
| served_at | timestamp(3) nullable | |
| prep_seconds | unsignedInteger nullable | ready_at − fired_at (reporting) |
| is_recalled | boolean default false | brought back from done |
| sequence_in_display | unsignedInteger nullable | manual reordering / priority bump |
| timestamps | | |
| index | (prep_display_id, state, fired_at) | the main board query |

### `prep_order_lines`
New. One row per (prep_order, order line, fired quantity batch). Quantities are **deltas** so a
second fire of the same product creates a second row rather than mutating a served one.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| prep_order_id | FK→prep_orders.id, cascade, index | |
| pos_order_line_id | FK→pos_order_lines.id nullable, set null, index | null if the source line was deleted |
| pos_order_line_uuid | char(36), index | survives line deletion (cancel tickets) |
| prep_stage_id | FK→prep_stages.id nullable, set null, index | current column |
| restaurant_course_id | FK→restaurant_order_courses.id nullable, set null | grouping header |
| course_index | unsignedSmallInteger default 1 | frozen |
| product_id | FK→products.id, restrict | |
| pos_category_id | FK→pos_categories.id nullable, set null | frozen routing category |
| display_name | string(255) | frozen name incl. attributes |
| quantity | decimal(16,3) | **signed**: negative = cancellation of previously-sent quantity |
| change_type | enum('new','cancelled','note_update','fire_course') default 'new', index | mirrors the delta engine's ticket kinds |
| customer_note | string(255) nullable | |
| internal_note | text nullable | |
| combo_parent_uuid | char(36) nullable | combo children follow their parent's routing |
| state | enum('todo','in_progress','ready','served','cancelled') default 'todo', index | |
| started_at, ready_at, served_at | timestamp(3) nullable | |
| fired_at | timestamp(3), index | |
| timestamps | | |
| index | (prep_order_id, course_index, id) | render order |

### `prep_line_stage_logs`
Who moved what, when — the KDS audit trail and the source of prep-time analytics. New.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| prep_order_line_id | FK→prep_order_lines.id, cascade, index | |
| from_stage_id | FK→prep_stages.id nullable, set null | |
| to_stage_id | FK→prep_stages.id nullable, set null | |
| from_state, to_state | string(16) | |
| employee_id | FK→employees.id nullable, set null | |
| moved_at | timestamp(3), index | |
| duration_seconds | unsignedInteger nullable | time spent in the previous stage |
| timestamps | | *(created_at only in practice)* |

### `preparation_print_jobs`
Durable, idempotent print queue for prep tickets, bills and receipts. New (Odoo printed
fire-and-forget from the browser and offered a Retry popup).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | client-generated ⇒ retries never double-print |
| company_id | FK→companies.id, cascade | |
| pos_config_id | FK→pos_configs.id, cascade, index | |
| pos_printer_id | FK→pos_printers.id nullable, set null, index | null ⇒ "any printer of this config" |
| pos_order_id | FK→pos_orders.id nullable, set null, index | |
| pos_device_id | FK→pos_devices.id nullable, set null | requesting device |
| job_type | enum('prep_new','prep_cancelled','prep_note_update','prep_fire_course','bill','receipt','tip_slip','cash_report','test') , index | |
| payload | json | rendered ticket model (lines, groups, header/footer) — printable without re-querying |
| rendered_text | text nullable | pre-rendered ESC/POS or plain text |
| copies | unsignedTinyInteger default 1 | |
| state | enum('queued','printing','printed','failed','skipped') default 'queued', index | |
| attempts | unsignedTinyInteger default 0 | |
| last_error | string(255) nullable | |
| queued_at | timestamp(3), index | |
| printed_at | timestamp(3) nullable | |
| timestamps | | |
| index | (pos_printer_id, state, queued_at) | printer poll query |

---

## 2.I Self-order (QR menu / mobile / kiosk)

Most of the self-order feature set lives as **columns on existing tables** (documented above):
`pos_configs.self_ordering_*`, `restaurant_tables.identifier`, `pos_orders.access_token` /
`source` / `self_order_table_id` / `table_stand_number`, `products.self_order_available`,
`product_variants.self_order_available`, `pos_categories.self_order_visible`,
`pos_presets.available_in_self` / `service_at` / `notification_template_id`,
`media_files.collection ∈ {self_home, self_background, brand}`, `pos_config_language`,
`payment_providers` / `payment_transactions`.

Only one new table is required:

### `self_order_custom_links`
Configurable buttons on the self-order landing page.
Maps from `pos_self_order.custom_link`. Dropped: the computed `link_html` preview.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(64) | |
| url | string(512) | may be relative (`/products`) or absolute |
| style | enum('primary','secondary','success','danger','warning','info','light','dark') default 'primary' | |
| open_in_new_tab | boolean default false | |
| sequence | integer default 10, index | |
| active | boolean default true | |
| timestamps | | |

(+ pivot `pos_config_self_order_custom_link`, defined in §2.D. **Empty pivot ⇒ the link shows on
every config**, preserving Odoo semantics.)

### Token model (no table — documented contract)
| Token | Column | Scope |
|---|---|---|
| Config access token | `pos_configs.access_token` (char 32) | entry to the self-order app + **broadcast channel name** |
| Table capability token | `restaurant_tables.identifier` (char 8) | proves "I scanned table N" |
| Order capability token | `pos_orders.access_token` (char 36) | read / cancel / pay *that* order |
| Receipt portal code | `pos_orders.ticket_code` (char 5) + `receipt_number` + date | self-service invoice request |
| Device token | `pos_devices.uuid` | register identity for sync fan-out |

Rotation: regenerating `pos_configs.access_token` **must** cascade to every
`restaurant_tables.identifier` of that config's floors (invalidates all printed QRs) — a single
service method, mirroring `update_access_tokens()`.

---

## 2.J Loyalty & promotions

### `loyalty_programs`
Maps from `loyalty.program`. Dropped: portal point display settings, `applies_on='future'`
next-order-coupon chaining is kept but the mail-merge machinery is replaced by
`loyalty_communications` + `notification_templates`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| company_id | FK→companies.id, cascade | |
| name | string(96) | |
| program_type | enum('coupons','gift_card','loyalty','promotion','promo_code','buy_x_get_y','ewallet','next_order_coupons') , index | §4.11 |
| trigger | enum('auto','with_code') default 'auto' | |
| applies_on | enum('current','future','both') default 'current' | |
| currency_id | FK→currencies.id, restrict | must match the config currency |
| date_from | date nullable, index | |
| date_to | date nullable, index | |
| limit_usage | boolean default false | |
| max_usage | unsignedInteger nullable | |
| points_name | string(32) default 'Points' | |
| is_nominative | boolean default false | requires a customer (loyalty/ewallet) |
| is_payment_program | boolean default false | gift card / ewallet: 1 point = 1 currency unit |
| available_in_pos | boolean default true, index | `pos_ok` |
| print_report_on_issue | boolean default false | print the generated gift card |
| sequence | integer default 10 | evaluation order when several apply |
| active | boolean default true, index | |
| timestamps | | |

### `loyalty_program_pos_config` (pivot)
`loyalty_program_id` FK cascade U, `pos_config_id` FK cascade U.
**Empty ⇒ applies to all configs** (Odoo semantics).

### `loyalty_program_pricelist` (pivot)
`loyalty_program_id` FK cascade U, `pricelist_id` FK cascade U. Restricts a program to pricelists.

### `loyalty_rules`
Earning / triggering conditions. Maps from `loyalty.rule`. Dropped: `domain` (arbitrary Odoo
domain) — replaced by explicit product/category/tag pivots (covers every real use case and is
evaluable offline by the client).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| loyalty_program_id | FK→loyalty_programs.id, cascade, index | |
| mode | enum('auto','with_code') default 'auto' | |
| code | string(48) nullable | unique(company-through-program, code) when set |
| promo_barcode | string(64) nullable, index | scannable alternative to the code |
| minimum_quantity | decimal(16,3) default 0 | |
| minimum_amount | decimal(16,4) default 0 | |
| minimum_amount_tax_mode | enum('incl','excl') default 'incl' | |
| reward_point_amount | decimal(16,3) default 1 | |
| reward_point_mode | enum('order','money','unit') default 'order' | per order / per currency unit / per product unit |
| reward_point_split | boolean default false | issue one coupon per point |
| applies_to_all_products | boolean default true | denormalised: no product/category/tag rows |
| sequence | integer default 10 | |
| timestamps | | |

### `loyalty_rule_product` / `loyalty_rule_pos_category` / `loyalty_rule_product_tag` (pivots)
`loyalty_rule_id` FK cascade U + (`product_id` | `pos_category_id` | `product_tag_id`) FK cascade U.

### `loyalty_rewards`
Maps from `loyalty.reward`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| loyalty_program_id | FK→loyalty_programs.id, cascade, index | |
| reward_type | enum('discount','product','shipping') default 'discount' | |
| description | string(160) | shown in the reward picker |
| required_points | decimal(16,3) default 1 | |
| clear_wallet | boolean default false | spends the whole balance |
| **discount** | | |
| discount_value | decimal(16,4) default 0 | |
| discount_mode | enum('percent','per_point','per_order') default 'percent' | |
| discount_applicability | enum('order','cheapest','specific') default 'order' | |
| discount_max_amount | decimal(16,4) nullable | cap |
| is_global_discount | boolean default false | interacts with `pos_configs.enable_global_discount` |
| discount_line_product_id | FK→products.id nullable, restrict | the product used on the negative line |
| **free product** | | |
| reward_product_id | FK→products.id nullable, restrict | single free product |
| reward_product_quantity | decimal(16,3) default 1 | |
| multi_product | boolean default false | customer picks among `loyalty_reward_product` rows |
| sequence | integer default 10 | |
| active | boolean default true | |
| timestamps | | |

### `loyalty_reward_product` (pivot)
`loyalty_reward_id` FK cascade U, `product_id` FK cascade U — the choice set for multi-product
rewards *and* the "specific products" scope of a discount reward (distinguished by
`loyalty_rewards.discount_applicability`/`multi_product`).

### `loyalty_cards`
A coupon / gift card / eWallet / loyalty account instance. Maps from `loyalty.card`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | POS can mint gift cards offline |
| loyalty_program_id | FK→loyalty_programs.id, cascade, index | |
| company_id | FK→companies.id, cascade | |
| code | string(48) **unique** | scannable/typeable |
| barcode | string(64) nullable, index | |
| customer_id | FK→customers.id nullable, set null, index | required for nominative programs |
| points | decimal(16,3) default 0, index | current balance |
| points_issued_total | decimal(16,3) default 0 | lifetime |
| points_spent_total | decimal(16,3) default 0 | |
| expires_at | date nullable, index | |
| use_count | unsignedInteger default 0 | |
| source_pos_order_id | FK→pos_orders.id nullable, set null | the order that sold/issued it |
| is_paid | boolean default true | gift card sold but order not yet paid ⇒ warn on use |
| active | boolean default true, index | rewards in use are archived, never deleted |
| timestamps | | |

### `loyalty_card_histories`
Immutable ledger of point movements. Maps from `loyalty.history`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| loyalty_card_id | FK→loyalty_cards.id, cascade, index | |
| pos_order_id | FK→pos_orders.id nullable, set null, index | |
| movement_type | enum('earn','spend','adjust','expire','topup','issue') default 'earn', index | |
| points | decimal(16,3) | signed |
| balance_after | decimal(16,3) | |
| description | string(160) nullable | |
| employee_id | FK→employees.id nullable, set null | |
| occurred_at | timestamp(3), index | |
| timestamps | | |

### `pos_order_loyalty_points`
The point changes claimed by one order, staged at order sync and confirmed at payment.
Maps from the `point_changes` / `confirm_coupon_programs` RPC payload (Odoo kept it transient).
Persisting it makes the "validate coupons at payment" step replayable and idempotent offline.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| loyalty_card_id | FK→loyalty_cards.id nullable, set null | null when the card is created at confirmation |
| loyalty_program_id | FK→loyalty_programs.id, restrict | |
| points_delta | decimal(16,3) | signed |
| new_card_code | string(48) nullable | code to create at confirmation (gift card sale) |
| state | enum('pending','confirmed','rejected','reverted') default 'pending', index | |
| rejection_reason | string(160) nullable | expired / already used / wrong pricelist |
| confirmed_at | timestamp(3) nullable | |
| timestamps | | |

### `loyalty_communications`
"When X happens, send template Y." Maps from `loyalty.mail`.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| loyalty_program_id | FK→loyalty_programs.id, cascade | |
| trigger | enum('create','points_reach','expiry_soon') default 'create' | |
| points_threshold | decimal(16,3) nullable | |
| notification_template_id | FK→notification_templates.id, restrict | |
| timestamps | | |

---

## 2.K Audit & sync

### `audit_logs`
Single polymorphic trail replacing Odoo's chatter + `log_partner_message`.
Records: cash drawer opened, cash move created/deleted, session opened/closed with differences,
payment method changed on an order, receipt header edited, price overridden, config changed,
access-token rotation, employee login/logout, KDS recall.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| pos_config_id | FK→pos_configs.id nullable, set null, index | |
| pos_session_id | FK→pos_sessions.id nullable, set null, index | |
| subject_type | string(96), index | polymorphic model class |
| subject_id | unsignedBigInteger, index | |
| event | string(64), index | `cash.move.deleted`, `order.payment.changed`, `session.closed`, … |
| severity | enum('info','notice','warning','critical') default 'info', index | |
| actor_user_id | FK→users.id nullable, set null | |
| actor_employee_id | FK→employees.id nullable, set null | |
| pos_device_id | FK→pos_devices.id nullable, set null | |
| message | string(500) nullable | human-readable |
| changes | json nullable | `{field: {old, new}}` |
| ip_address | string(45) nullable | |
| occurred_at | timestamp(3), index | |
| timestamps | | |
| index | (subject_type, subject_id, occurred_at) | |

### `pos_order_edit_logs`
Fine-grained line-level edit trail, only written when `pos_configs.order_edit_tracking` is on.
Maps from Odoo's `is_edited` / `has_deleted_line` chatter messages.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_order_id | FK→pos_orders.id, cascade, index | |
| pos_order_line_id | FK→pos_order_lines.id nullable, set null | |
| pos_order_line_uuid | char(36) nullable, index | survives deletion |
| action | enum('line_added','line_removed','qty_decreased','qty_increased','price_changed','discount_changed','note_changed','payment_changed','order_cancelled') , index | |
| product_name | string(255) nullable | frozen |
| old_value, new_value | string(96) nullable | |
| amount_impact | decimal(16,4) default 0 | signed revenue impact |
| employee_id | FK→employees.id nullable, set null | |
| pos_device_id | FK→pos_devices.id nullable, set null | which till — employees share PINs, devices do not |
| occurred_at | timestamp(3), index | |
| timestamps | | |
| index | (pos_order_id, occurred_at) | the per-order edit history |

### `sync_requests`
Request-level idempotency + replay protection for the offline queue. A device retrying a batch that
already landed gets the stored response instead of a duplicate write.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| request_uuid | char(36) **unique** | client-generated per sync batch |
| pos_device_id | FK→pos_devices.id nullable, set null, index | |
| pos_config_id | FK→pos_configs.id, cascade, index | |
| endpoint | string(64), index | `orders.sync`, `session.close`, `cash.move`, … |
| payload_hash | char(64) | sha-256 of the canonicalised body — mismatch on the same uuid = a client bug, logged as a conflict |
| record_uuids | json nullable | uuids touched (for tracing) |
| response_status | unsignedSmallInteger nullable | |
| response_body | json nullable | replayed verbatim on retry |
| processed_at | timestamp(3) nullable, index | |
| duration_ms | unsignedInteger nullable | |
| timestamps | | |

Retention: pruned by a scheduled job after `pos.sync_retention_days` (default 30).

### `sync_conflicts`
Anything the sync layer had to resolve or reject — the ops queue.

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| pos_config_id | FK→pos_configs.id, cascade, index | |
| pos_device_id | FK→pos_devices.id nullable, set null | |
| conflict_type | enum('stale_write','duplicate_table_order','closed_session','uuid_collision','prep_snapshot_stale','payload_mismatch','price_tamper') , index | |
| model_type | string(96) | |
| record_uuid | char(36), index | |
| resolution | enum('server_wins','client_wins','merged','rerouted','rejected') , index | |
| detail | json nullable | both versions, for post-mortem |
| detected_at | timestamp(3), index | |
| resolved_by_user_id | FK→users.id nullable, set null | |
| acknowledged_at | timestamp nullable | |
| timestamps | | |

### `notification_logs`
Delivery record for receipt emails/SMS (replaces `mail.mail` tracking).

| Column | Type | Notes |
|---|---|---|
| id | id | |
| uuid | char(36) **unique** | |
| company_id | FK→companies.id, cascade | |
| notification_template_id | FK→notification_templates.id nullable, set null | |
| pos_order_id | FK→pos_orders.id nullable, set null, index | |
| loyalty_card_id | FK→loyalty_cards.id nullable, set null | |
| channel | enum('email','sms') , index | |
| recipient | string(160), index | |
| subject | string(255) nullable | |
| state | enum('queued','sent','failed','bounced') default 'queued', index | |
| error_message | string(255) nullable | |
| sent_at | timestamp(3) nullable | |
| timestamps | | |

### Laravel framework tables (unchanged defaults, listed for completeness)
`users` (above), `password_reset_tokens`, `sessions`, `cache`, `cache_locks`, `jobs`,
`job_batches`, `failed_jobs`, `personal_access_tokens` (Sanctum — one token per `pos_device`),
`migrations`.

---

## 3. Table inventory (quick index)

| # | Domain | Tables |
|---|---|---|
| 1 | Identity/access/devices (16) | `companies`, `users`, `roles`, `permissions`, `permission_role`, `role_user`, `employees`, `pos_config_employee`, `customers`, `pos_devices`, `countries`, `country_states`, `languages`, `media_files` (+ framework `password_reset_tokens`, `personal_access_tokens`) |
| 2 | Catalog (22) | `pos_categories`, `product_categories`, `products`, `product_variants`, `pos_category_product`, `product_tags`, `product_tag_product`, `product_optional_products`, `product_attributes`, `product_attribute_values`, `product_attribute_lines`, `product_attribute_line_values`, `product_variant_attribute_value`, `product_attribute_exclusions`, `combos`, `combo_items`, `combo_product`, `uom_categories`, `uoms`, `product_packagings`, `barcode_nomenclatures`, `barcode_rules` |
| 3 | Pricing/tax (13) | `currencies`, `currency_rates`, `tax_groups`, `taxes`, `tax_children`, `product_tax`, `product_variant_tax`, `fiscal_positions`, `fiscal_position_taxes`, `pricelists`, `pricelist_items`, `cash_roundings`, `decimal_precisions` |
| 4 | Config (24) | `pos_configs`, `pos_config_payment_method`, `pos_config_pricelist`, `pos_config_fiscal_position`, `pos_config_preset`, `pos_config_printer`, `pos_config_note`, `pos_config_bill`, `pos_config_pos_category`, `pos_config_trusted_config`, `pos_config_floor`, `pos_config_language`, `pos_config_prep_display`, `pos_config_self_order_custom_link`, `sequences`, `pos_presets`, `preset_service_windows`, `pos_notes`, `pos_bills`, `pos_printers`, `pos_category_pos_printer`, `payment_methods`, `payment_providers`, `notification_templates`, `settings` |
| 5 | Session/cash (9) | `pos_sessions`, `cash_movements`, `session_cash_counts`, `session_cash_count_lines`, `session_payment_totals`, `session_sales_summaries`, `session_tax_summaries`, `accounting_exports`, `accounting_export_session` |
| 6 | Orders (9) | `pos_orders`, `pos_order_lines`, `pos_order_line_attribute_value`, `pos_order_line_custom_attribute_values`, `pos_payments`, `payment_transactions`, `pos_invoices`, `pos_invoice_lines`, `customer_account_moves` |
| 7 | Restaurant (4) | `restaurant_floors`, `restaurant_tables`, `restaurant_order_courses`, `pos_order_merges` |
| 8 | Kitchen (8) | `order_preparation_snapshots`, `prep_displays`, `pos_category_prep_display`, `prep_stages`, `prep_orders`, `prep_order_lines`, `prep_line_stage_logs`, `preparation_print_jobs` |
| 9 | Self-order (1 + columns) | `self_order_custom_links` |
| 10 | Loyalty (12) | `loyalty_programs`, `loyalty_program_pos_config`, `loyalty_program_pricelist`, `loyalty_rules`, `loyalty_rule_product`, `loyalty_rule_pos_category`, `loyalty_rule_product_tag`, `loyalty_rewards`, `loyalty_reward_product`, `loyalty_cards`, `loyalty_card_histories`, `pos_order_loyalty_points`, `loyalty_communications` |
| 11 | Audit/sync (5) | `audit_logs`, `pos_order_edit_logs`, `sync_requests`, `sync_conflicts`, `notification_logs` |

**Total: ~120 application tables + 8 Laravel framework tables.**

---

## 4. Enumerations (authoritative value lists)

All enums are backed PHP enums (`string`) + a DB `CHECK`. Values are stable API contract — never
renumber, only append.

### 4.1 `pos_orders.state`
| Value | Meaning | Entered by | Exits to |
|---|---|---|---|
| `draft` | open / parked / self-order submitted, not settled | creation | `paid`, `cancelled` |
| `paid` | fully settled (payments ≥ total ± rounding tolerance) | payment validation | `done` |
| `done` | finalised & included in a closed session's summaries | session close, or invoicing | — (terminal) |
| `cancelled` | voided before payment | explicit cancel | — (terminal) |

Rules: `paid`/`done`/`cancelled` can never return to `draft`. Only `draft`/`cancelled` orders may be
hard-deleted. "Sent to kitchen" is **not** a state — it is `order_preparation_snapshots` +
`prep_orders`. Restaurant-specific derived labels: `TIPPING` (paid + `tip_after_payment` + not yet
tipped), `OPEN` (draft with a table), `Ongoing` (draft from self-order).

### 4.2 `pos_sessions.state`
| Value | Meaning |
|---|---|
| `opening_control` | created, cashier is counting the opening float |
| `opened` | trading |
| `closing_control` | trading stopped, counting/reconciling |
| `closed` | terminal; summaries frozen, orders forced to `done` |

Transitions are strictly forward. A `is_rescue` session skips `opening_control` and cannot be
closed from the register UI (back-office only).

### 4.3 Preparation states
`pos_orders.prep_state`: `none` → `pending` → `sent` → `partially_ready` → `ready` → `served`.
`prep_orders.state`: `pending` → `in_progress` → `ready` → `served`, plus `cancelled`.
`prep_order_lines.state`: `todo` → `in_progress` → `ready` → `served`, plus `cancelled`.
`prep_stages.stage_type`: `todo` | `in_progress` | `ready` | `done`.
`prep_order_lines.change_type`: `new` | `cancelled` | `note_update` | `fire_course`
(the four ticket kinds produced by the delta engine).

### 4.4 `cash_movements.movement_type`
`cash_in` (+), `cash_out` (−), `opening_float` (+, seeded from the previous close),
`closing_lift` (−, drawer emptied at close), `difference` (± the counted over/short, written at
close so the drawer maths balances).

### 4.5 `payment_methods.method_type`
| Value | Counted in drawer | Change allowed | Notes |
|---|---|---|---|
| `cash` | yes | yes | at most one config per method |
| `bank` | no | no | manual card/bank transfer, no terminal |
| `card_terminal` | no | no | integrated terminal (`terminal_provider`) |
| `qr_code` | no | no | static/dynamic bank QR |
| `online` | no | no | hosted page / self-order online payment; ≤1 per config |
| `customer_account` | no | no | pay later / on account; forces a customer |
| `voucher` | no | no | gift card / eWallet settlement (loyalty payment programs) |

### 4.6 Payment & transaction statuses
`pos_payments.payment_status`: `pending` | `authorized` | `done` | `reversed` | `failed` |
`cancelled`.
`payment_transactions.state`: `draft` | `pending` | `authorized` | `done` | `cancelled` | `error`.
`payment_providers.state`: `disabled` | `test` | `enabled`.

### 4.7 `pos_orders.source`
`pos` (register), `mobile` (QR self-order), `kiosk`, `backoffice` (created/refunded from admin),
`api` (integration/delivery platform).

### 4.8 Roles & access
`roles.slug` (seeded): `admin`, `pos_manager`, `pos_user`, `report_viewer`.
`employees.default_role` / effective register role: any `till_roles.slug` of the venue — the three
seeded ones (`minimal` | `cashier` | `manager`) plus whatever it has authored (BAN-451).
Resolution order: `pos_config_employee.role_slug`, then `access_level`, then `default_role`.
`pos_config_employee.access_level`: `minimal` | `basic` | `advanced` (advanced ⇒ `manager`).
Permission gates that must exist (slug list in `permissions`):
`cash.move.create`, `cash.move.delete`, `session.open`, `session.close`,
`session.close.over_diff`, `order.price.edit`, `order.discount.manual`, `order.payment.edit`,
`order.cancel`, `order.refund`, `margin.view`, `product.create`, `product.edit`,
`receipt.header.edit`, `config.manage`, `floor.edit`, `loyalty.manage`, `report.view`,
`export.accounting`.

### 4.9 `taxes.amount_type`
| Value | Formula | Notes |
|---|---|---|
| `percent` | `base × amount/100` | standard VAT |
| `fixed` | `amount × quantity` | per-unit excise/eco-tax |
| `division` | `base × amount/100` where the price **already includes** the tax: `tax = price − price × (1 − amount/100)` | Odoo "percentage of price tax included" |
| `group` | Σ of `tax_children` | composition only, no own amount |

Combined with `price_include`, `include_base_amount`, `is_base_affected` and `sequence`, this
reproduces Odoo's evaluation order exactly: sort by `sequence, id`; a tax with
`include_base_amount` adds its amount to the running base for subsequent taxes whose
`is_base_affected` is true.

### 4.10 `barcode_rules.rule_type`
`product`, `weight` (embedded weight → quantity), `price` (embedded price → `price_unit` +
`price_type='manual'`), `discount` (embedded % → `discount_percent`), `customer` (customer badge),
`cashier` (employee badge), `coupon` (loyalty code), `lot`, `package`, `alias`.

### 4.11 `loyalty_programs.program_type`
`coupons`, `gift_card`, `loyalty`, `promotion`, `promo_code`, `buy_x_get_y`, `ewallet`,
`next_order_coupons`.
Derived flags: `is_nominative` = `loyalty|ewallet`; `is_payment_program` = `gift_card|ewallet`.

### 4.12 Preset enums
`pos_presets.identification`: `none` | `name` | `address`.
`pos_presets.service_at`: `counter` | `table` | `delivery`.

### 4.13 Self-ordering enums + constraint matrix
`pos_configs.self_ordering_mode`: `nothing` | `consultation` | `mobile` | `kiosk`.
`self_ordering_service_mode`: `counter` | `table`. `self_ordering_pay_after`: `each` | `meal`.

| Condition | Forced value |
|---|---|
| mode = `kiosk` | `pay_after = each`; cash payment methods forbidden; `is_restaurant` irrelevant |
| mode = `mobile` AND service = `counter` | `pay_after = each` |
| mode = `mobile` AND NOT `is_restaurant` | `pay_after = each` |
| mode = `mobile` AND `pay_after = meal` | `service_mode = table` |
| mode = `consultation` | browse-only; no order endpoints; works with a closed session |
| mode ≠ `nothing` | `self_ordering_default_user_id` required |

### 4.14 Remaining small enums
| Table.column | Values |
|---|---|
| `pos_configs.tax_display` | `subtotal` \| `total` |
| `pos_configs.default_screen` | `tables` \| `register` |
| `companies.tax_calculation_rounding_method` | `round_per_line` \| `round_globally` |
| `cash_roundings.rounding_method` | `half_up` \| `up` \| `down` |
| `pricelist_items.applied_on` | `variant` \| `product` \| `pos_category` \| `global` |
| `pricelist_items.compute_price` | `fixed` \| `percentage` \| `formula` |
| `pricelist_items.base` | `list_price` \| `standard_price` \| `pricelist` |
| `products.product_type` | `consumable` \| `service` \| `combo` |
| `products.special_kind` | `none` \| `tip` \| `global_discount` \| `loyalty_reward` \| `deposit` |
| `product_attributes.display_type` | `radio` \| `pills` \| `select` \| `color` \| `multi` |
| `product_attributes.create_variant` | `always` \| `dynamic` \| `no_variant` |
| `pos_order_lines.price_type` | `original` \| `manual` \| `automatic` |
| `pos_printers.printer_type` | `iot` \| `epson_epos` \| `network_escpos` \| `browser` |
| `preparation_print_jobs.job_type` | `prep_new` \| `prep_cancelled` \| `prep_note_update` \| `prep_fire_course` \| `bill` \| `receipt` \| `tip_slip` \| `cash_report` \| `test` |
| `preparation_print_jobs.state` | `queued` \| `printing` \| `printed` \| `failed` \| `skipped` |
| `restaurant_tables.shape` | `square` \| `round` |
| `pos_order_merges.merge_type` | `table_link` \| `order_transfer` \| `order_merge` \| `split` |
| `pos_invoices.invoice_type` | `invoice` \| `credit_note` |
| `pos_invoice_lines.line_type` | `product` \| `section` \| `note` \| `rounding` \| `discount` |
| `session_cash_counts.count_type` | `opening` \| `closing` \| `mid_shift` |
| `accounting_exports.state` | `draft` \| `generated` \| `sent` \| `failed` |
| `sync_conflicts.conflict_type` | `stale_write` \| `duplicate_table_order` \| `closed_session` \| `uuid_collision` \| `prep_snapshot_stale` \| `payload_mismatch` \| `price_tamper` |
| `audit_logs.severity` | `info` \| `notice` \| `warning` \| `critical` |
| `media_files.collection` | `image` \| `self_home` \| `self_background` \| `brand` \| `floor_background` \| `receipt_logo` \| `avatar` |

---

## 5. The POS bootstrap payload contract

Replaces Odoo's `pos.session.load_data_params()` / `load_data()` / `filter_local_data()` RPC trio
and `pos.config.load_self_data()`.

### 5.1 Endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/pos/{config}/schema` | device token | Field + relation metadata per entity so the client can build its mini-ORM (mirrors `load_data_params`). Cached by `config_revision`. |
| `GET` | `/api/pos/{config}/bootstrap` | device token | **Full snapshot** of all eager entities. Returns `server_time` (ms precision) and `config_revision`. |
| `GET` | `/api/pos/{config}/delta?since={server_time}` | device token | Incremental: rows with `updated_at > since` per entity + a `tombstones` map. |
| `GET` | `/api/pos/{config}/tombstones?since=` | device token | ids the client must purge (see 5.5). |
| `POST` | `/api/pos/{config}/devices/register` | user token | Allocates `device_identifier`, returns a device token. |
| `GET` | `/api/self-order/{config}/bootstrap` | config `access_token` | Anonymous self-order profile (narrower field/row set). |
| `GET` | `/api/prep/{display}/bootstrap` | display `access_token` | KDS profile. |

All three bootstrap profiles share one serializer layer with a **profile** argument
(`register` | `self_order` | `prep_display`) — the direct analogue of Odoo's
`_load_pos_data_*` vs `_load_pos_self_data_*` hook pairs.

### 5.2 Load order (dependency-ordered; the client resolves relations as it goes)

```
1  settings, decimal_precisions, currencies, currency_rates
2  companies, countries, country_states, languages
3  tax_groups, taxes, tax_children, fiscal_positions, fiscal_position_taxes, cash_roundings
4  uom_categories, uoms
5  pos_categories
6  product_categories, product_tags
7  products → product_variants → product_packagings
8  product_tax, product_variant_tax, pos_category_product, product_tag_product,
   product_optional_products
9  product_attributes, product_attribute_values, product_attribute_lines,
   product_attribute_line_values, product_variant_attribute_value, product_attribute_exclusions
10 combos, combo_items, combo_product
11 pricelists, pricelist_items
12 barcode_nomenclatures, barcode_rules
13 payment_methods, payment_providers
14 pos_presets, preset_service_windows, pos_notes, pos_bills, pos_printers,
   pos_category_pos_printer
15 restaurant_floors, restaurant_tables
16 prep_displays, prep_stages
17 loyalty_programs, loyalty_rules (+ scope pivots), loyalty_rewards, loyalty_reward_product
18 pos_configs (+ every pos_config_* pivot)      ← after its referents
19 employees (+ pos_config_employee), users (self only), customers
20 pos_sessions (current), pos_devices
21 pos_orders (open only) → pos_order_lines → pos_order_line_attribute_value,
   pos_order_line_custom_attribute_values, pos_payments, restaurant_order_courses,
   order_preparation_snapshots, pos_order_loyalty_points
22 loyalty_cards (only those referenced by open orders + the loaded customers)
23 notification_templates, self_order_custom_links, media_files (metadata only)
```

### 5.3 Eager (pushed at startup) — with config-scoped filtering rules

| Entity | Filter (register profile) | Notes |
|---|---|---|
| `settings` | `company_id = cfg.company_id OR NULL` | client constants |
| `decimal_precisions` | all | tiny |
| `currencies` | company currency + config currency + every currency of loaded pricelists | |
| `currency_rates` | latest row per loaded currency | not the history |
| `companies` | the config's company only | |
| `countries` / `country_states` | all countries (~250 rows); states only for the company country + countries of loaded customers | |
| `languages` | `active = true` | |
| `tax_groups` / `taxes` / `tax_children` | `company_id = cfg.company_id` (**incl. `active=false`** — historical orders reference them) | |
| `fiscal_positions` | those in `pos_config_fiscal_position` + `cfg.default_fiscal_position_id` + fiscal positions of the loaded presets + of the loaded customers | |
| `fiscal_position_taxes` | rows of the loaded fiscal positions | |
| `cash_roundings` | `cfg.cash_rounding_id` only | |
| `uoms` / `uom_categories` | all of the company (incl. archived) | |
| `pos_categories` | if `cfg.limit_categories`: the categories in `pos_config_pos_category` **plus all their descendants** **plus** every category referenced by the config's printers/prep displays; else all active company categories | matches Odoo's domain exactly |
| `product_categories` | all of the company | small |
| `products` | `company_id = cfg.company_id AND available_in_pos AND sale_ok AND active` AND (if `limit_categories`) has a row in `pos_category_product` for a loaded category — **capped at `cfg.limited_product_count`** ordered by `is_favorite DESC, product_type='service' DESC, last_sold_at DESC, updated_at DESC`; **force-included regardless of the cap**: `is_special` products (tip / global discount / reward), combo children, `product_optional_products` targets, and every product referenced by a loaded open order line | Odoo's limited-loading SQL, verbatim in intent |
| `product_variants` | variants of loaded products (`active` and inactive-but-referenced) | |
| `product_packagings` | of loaded variants | barcode scanning |
| `product_tax` / `product_variant_tax` | of loaded products/variants | |
| `pos_category_product`, `product_tag_product`, `product_optional_products` | of loaded products | |
| `product_tags` | `visible_to_customers` any; all company tags for the register profile | |
| `product_attributes` + `values` + `lines` + `line_values` + `variant_attribute_value` + `exclusions` | of loaded products | needed for the configurator offline |
| `combos`, `combo_items`, `combo_product` | of loaded products | |
| `pricelists` | `pos_config_pricelist` rows + `cfg.pricelist_id` + preset pricelists + any `base_pricelist_id` transitively referenced | |
| `pricelist_items` | items of the loaded pricelists restricted to loaded products/variants/categories **or** global items, **and** `date_end IS NULL OR date_end >= now()` | see 5.6 for the date-window sync caveat |
| `barcode_nomenclatures` / `barcode_rules` | `companies.barcode_nomenclature_id` + `cfg.fallback_barcode_nomenclature_id` | |
| `payment_methods` | via `pos_config_payment_method` (**incl. archived** — historical payments reference them) | |
| `payment_providers` | providers of the loaded online payment method | |
| `pos_presets`, `preset_service_windows` | via `pos_config_preset` + `cfg.default_preset_id` | |
| `pos_notes` | via `pos_config_note` | |
| `pos_bills` | `pos_config_bill` rows **or** bills with no config link (global) matching the config currency | |
| `pos_printers`, `pos_category_pos_printer` | via `pos_config_printer` | |
| `restaurant_floors` | via `pos_config_floor`, `active = true` | only when `cfg.is_restaurant` |
| `restaurant_tables` | tables of the loaded floors, `active = true` | |
| `prep_displays`, `prep_stages`, `pos_category_prep_display` | via `pos_config_prep_display` | only when `cfg.use_preparation_display` |
| `loyalty_programs` + rules + rewards + scope pivots | `available_in_pos AND active` AND (`loyalty_program_pos_config` empty OR contains cfg) AND currency = cfg currency AND date window covers today AND usage limit not exhausted | only when `cfg.enable_loyalty` |
| `pos_configs` | the config itself + its `pos_config_trusted_config` peers (id/name/currency only) | full row, no field whitelist |
| all `pos_config_*` pivots | rows of the loaded configs | |
| `employees` | if `pos_config_employee` has rows: those employees; else all active company employees. Fields: `id, uuid, name, avatar, default_role, barcode_hash, pin_hash (presence flag only → send `has_pin`), access_level` | **never send raw barcode/PIN** |
| `users` | the authenticated user only (`id, name, role slugs, permission slugs`) | |
| `customers` | top `cfg.limited_customer_count` by `order_count DESC, name` + the current user's customer + every customer referenced by a loaded open order + every customer with a loyalty card referenced by an open order | Odoo's top-N preload |
| `pos_sessions` | the config's current non-closed session (all fields) | |
| `pos_devices` | devices of the config (`id, uuid, device_identifier, name, current_employee_id`) | multi-till awareness |
| `pos_orders` | `pos_config_id ∈ {cfg} ∪ trusted configs` AND `state = 'draft'` AND `deleted_at IS NULL` — i.e. **open/parked orders are restored at startup** | plus, when `cfg.self_ordering_mode ≠ nothing`, draft orders with `source ∈ (mobile, kiosk)` |
| `pos_order_lines` + attribute pivots + custom values + `pos_payments` + `restaurant_order_courses` + `order_preparation_snapshots` + `pos_order_loyalty_points` | children of the loaded orders | |
| `loyalty_cards` | cards referenced by loaded orders + cards of loaded customers, `active = true` | never the whole card table |
| `notification_templates` | templates of the company referenced by the config/presets | ids + name only for the register |
| `self_order_custom_links` | via pivot (empty pivot ⇒ all) | only when self-ordering enabled |
| `media_files` | **metadata only** (`id, model, collection, checksum, variants`) — never binary; images are fetched by URL and cached by the service worker | Odoo shipped `image_128` as a bool flag; same idea, richer |

### 5.4 Lazy-loaded / paginated (never in the bootstrap)

| Endpoint | Trigger | Contract |
|---|---|---|
| `GET /api/pos/{config}/products?search=&category=&cursor=&limit=100` | product search miss, category paging beyond the cap | Returns the full product bundle (product, variants, attributes+lines+values+exclusions, combos+items, packagings, taxes, applicable pricelist items) so the client can price it offline. Mirrors `load_product_from_pos`. |
| `GET /api/pos/{config}/products/by-barcode/{barcode}` | scan miss | Same bundle, single product; also resolves `product_packagings` and nomenclature-embedded weight/price. |
| `GET /api/pos/{config}/products/{id}/info` | product info popup | Price per pricelist, tax breakdown, margin/cost (gated by `margin.view`), on-hand qty. Mirrors `get_product_info_pos`. |
| `GET /api/pos/{config}/customers?search=&cursor=&limit=50` | customer search beyond the top-N | Mirrors `get_new_partner`; includes the customer's fiscal position + pricelist. |
| `POST /api/pos/{config}/customers` | create/edit from register | uuid-keyed upsert. |
| `GET /api/pos/{config}/pricelist-items?product_ids[]=` | after lazy-loading a product | Mirrors `get_pos_ui_product_pricelist_item_by_product`. |
| `GET /api/pos/{config}/orders?state=&from=&to=&search=&cursor=&limit=50` | ticket screen | Returns `[{id, uuid, updated_at}]` + total for cache diffing, then a second call hydrates the selected orders. Mirrors `search_paid_order_ids` + `read_pos_orders`. |
| `GET /api/pos/{config}/orders/{uuid}` | ticket screen detail, refund | Full order graph. |
| `GET /api/pos/{config}/open-orders?since=` | recovery / cross-register polling | `{records: {...}, tombstones: {...}}`. Mirrors `read_config_open_orders`. |
| `GET /api/pos/{config}/sessions/{id}/closing-data` | closing popup | Expected cash breakdown, per-method expected totals, `is_manager`, `amount_authorized_diff`, draft-order count, per-employee amounts. |
| `GET /api/pos/{config}/presets/{id}/slots?date=` | preset time-slot picker | Availability from `pos_orders.preset_time` + `preset_service_windows` + `slots_per_interval`. |
| `GET /api/pos/{config}/loyalty/cards?code=` / `?customer=` | coupon scan / customer select | Never bulk-loaded. |
| `GET /api/pos/{config}/reports/sales-details?...` | daily report | Server-side aggregation from `session_*_summaries`. |
| `GET /api/prep/{display}/orders?since=` | KDS polling fallback | Board rows; primary transport is WebSocket. |

**Never sent to any client:** `audit_logs`, `pos_order_edit_logs`, `sync_requests`,
`sync_conflicts`, `accounting_exports`, `session_sales_summaries`, `session_tax_summaries`,
`notification_logs`, `currency_rates` history, `pos_invoices`/`pos_invoice_lines` (fetched on
demand), `prep_line_stage_logs`, `loyalty_card_histories`.

### 5.5 Incremental sync & purge contract

- Every eager entity carries `updated_at` (ms precision). The client stores the `server_time`
  returned by the last successful call and sends it as `?since=`.
- **Exempt from `since` filtering** (always returned in full): `pos_configs`, `pos_sessions`, the
  authenticated `users` row, `settings`, `decimal_precisions`. (Same exemptions Odoo hard-codes.)
- **Tombstones**: `/tombstones?since=` returns `{entity: [ids]}` for rows that became invisible —
  `active=false`, `deleted_at` set, moved out of the config's scope (e.g. a product removed from an
  allowed category), or a draft order that was paid/cancelled/merged elsewhere. The client purges
  them from IndexedDB. Implementation: soft-deleted rows keep their `updated_at`, so a single scan
  per table with `WHERE updated_at > since` yields both upserts and tombstones — the serializer
  splits them by `deleted_at IS NULL / active`.
- **Full-reload trigger**: the bootstrap response carries `config_revision`. Any change to a
  config field, a config pivot, `limit_categories` scoping, tax definitions or pricelist membership
  bumps it. A client whose stored revision differs discards its cache and re-bootstraps. (Direct
  replacement for `pos.config.last_data_change`.)
- **Pricelist date windows**: a `pricelist_items` row whose `date_start` merely *became* current
  since the last sync has an unchanged `updated_at` and would be missed. The delta endpoint
  therefore ORs in `(date_start BETWEEN since AND now) OR (date_end BETWEEN since AND now)` for that
  entity — the exact special case Odoo implements in `product.pricelist.item`.

### 5.6 Self-order profile deltas (anonymous client)

Narrower rows **and** narrower fields:

| Entity | Difference vs register profile |
|---|---|
| `products` / `product_variants` | additionally `self_order_available = true`; fields limited to display+price+tax; no `standard_price`, no `margin`, no internal notes |
| `pos_categories` | additionally `self_order_visible = true`; time-window fields included (`hour_after`/`hour_until` filter the menu client-side) |
| `pos_presets` | `available_in_self = true AND in pos_config_preset`, plus the config default |
| `payment_methods` | **none by default**; kiosk ⇒ terminal + online methods of the config; mobile ⇒ only `cfg.self_order_online_payment_method_id` |
| `employees`, `users`, `pos_devices`, `pos_bills`, `pos_notes`, `pos_printers`, `cash_*` | **not sent at all** |
| `customers` | not sent; the client only ever knows the customer it just created |
| `pos_orders` | only orders whose `access_token` the client holds, plus (pay-after-`meal` + table mode) other draft orders on the same table |
| `restaurant_floors` / `restaurant_tables` | `id, name, table_number, identifier(own table only), floor_id` — the identifier of *other* tables is never disclosed |
| `pos_configs` | ~45-field whitelist: branding, colours, modes, languages, tax display, currency; **never** tokens other than its own `access_token`, never receipt header/footer of other configs |
| `notification_templates` | ids only (to know whether an email can be offered) |

Prices displayed by the self-order client are advisory: the server **recomputes every line price,
attribute extra and combo distribution on submission** (`recompute_prices` parity) and rejects
tampered payloads into `sync_conflicts.conflict_type = 'price_tamper'`.

### 5.7 Prep-display profile

`prep_displays` (own row), `prep_stages`, `prep_orders` + `prep_order_lines` where
`state ≠ 'served'` OR `served_at > now() − done_retention_minutes`, plus the label lookups
(`pos_categories`, `products.name`) needed to render. No prices, no customers, no payments.

### 5.8 Payload shape

```jsonc
{
  "server_time": "2026-07-28T14:03:11.482Z",
  "config_revision": 47,
  "profile": "register",
  "limits": { "products": 5000, "customers": 100, "products_total": 8321 },
  "data": {
    "products":        [ { "id": 1, "uuid": "…", "name": "…", "updated_at": "…" } ],
    "product_variants":[ … ]
  },
  "tombstones": { "products": [88, 91], "pos_orders": ["uuid-…"] }
}
```
Orders/lines/payments/courses are keyed by **uuid** in `tombstones` (the client may never have seen
the server id); master data is keyed by id.

---

## 6. Indexing & performance notes (sync-heavy tables)

### 6.1 The three query shapes that matter
1. **Bootstrap** — large range scans per entity, scoped by `company_id`/config pivots. Optimise for
   *sequential* reads and covering indexes; runs once per device per shift.
2. **Delta** — `WHERE updated_at > ? [AND company_id = ?]` on ~40 tables, every 5–30 s per device.
   This is the highest-frequency read in the system.
3. **Write burst** — order sync: 1 order + N lines + M payments + K courses upserted by uuid inside
   one transaction, from several devices at once, plus prep fan-out.

### 6.2 Required indexes (beyond the FK indexes Laravel creates)

| Table | Index | Serves |
|---|---|---|
| `pos_orders` | UNIQUE (`uuid`) | sync upsert — **the** hot lookup |
| `pos_orders` | (`pos_config_id`, `state`, `deleted_at`) | open-order bootstrap, floor-screen badges |
| `pos_orders` | (`pos_session_id`, `state`) | close guards, session totals |
| `pos_orders` | (`restaurant_table_id`, `state`) WHERE `state='draft'` (partial) | one-draft-order-per-table enforcement + table occupancy |
| `pos_orders` | (`company_id`, `updated_at`) | delta |
| `pos_orders` | (`pos_config_id`, `ordered_at` DESC, `id` DESC) | ticket-screen keyset pagination |
| `pos_orders` | (`access_token`) UNIQUE-ish | self-order/portal lookup |
| `pos_orders` | (`receipt_number`), (`tracking_number`) | portal invoice request, KDS lookup |
| `pos_order_lines` | UNIQUE (`uuid`) | sync upsert |
| `pos_order_lines` | (`pos_order_id`, `line_number`) | order render (covering: add `product_variant_id`, `quantity`, `price_subtotal_incl` as INCLUDE columns on PG) |
| `pos_order_lines` | (`product_variant_id`, `created_at`) | product sales reporting |
| `pos_order_lines` | (`pos_category_id`, `created_at`) | category reporting + prep routing backfill |
| `pos_order_lines` | (`refunded_order_line_id`) WHERE NOT NULL (partial) | refundable-qty computation |
| `pos_payments` | UNIQUE (`uuid`); (`pos_session_id`, `payment_method_id`); (`pos_order_id`) | sync + closing totals |
| `customer_account_moves` | UNIQUE (`uuid`); UNIQUE (`pos_payment_id`); (`customer_id`, `occurred_at`) | one-move-per-payment guard + statement view |
| `pos_sessions` | partial UNIQUE (`pos_config_id`) WHERE `state <> 'closed' AND NOT is_rescue` | one open session per register, enforced by the DB, not a race-prone app check |
| `pos_sessions` | (`pos_config_id`, `state`), (`business_date`), (`closed_at`) | dashboard, reports |
| `cash_movements` | (`pos_session_id`, `movement_type`), UNIQUE (`uuid`) | closing popup |
| `restaurant_order_courses` | UNIQUE (`uuid`); (`pos_order_id`, `course_index`) | order render, fire-course |
| `restaurant_tables` | (`restaurant_floor_id`, `active`); UNIQUE (`identifier`) | floor render, QR entry |
| `prep_orders` | (`prep_display_id`, `state`, `fired_at`); UNIQUE (`prep_display_id`,`pos_order_id`) | the KDS board query |
| `prep_order_lines` | (`prep_order_id`, `course_index`, `id`); (`prep_stage_id`, `state`) | board render, stage counts |
| `preparation_print_jobs` | (`pos_printer_id`, `state`, `queued_at`); UNIQUE (`uuid`) | printer polling, no double print |
| `products` | (`company_id`, `available_in_pos`, `active`); (`company_id`, `self_order_available`, `active`); (`is_special`) | bootstrap scoping |
| `products` / `product_variants` | (`updated_at`) | delta |
| `product_variants` | UNIQUE (`company_id`, `barcode`) WHERE barcode NOT NULL | scan resolution |
| `pricelist_items` | (`pricelist_id`, `applied_on`, `product_variant_id`), (`pricelist_id`, `applied_on`, `product_id`), (`pricelist_id`, `date_start`, `date_end`) | price resolution + date-window delta |
| `customers` | (`company_id`, `order_count` DESC); (`company_id`, `name`); trigram/`FULLTEXT` on (`name`,`email`,`phone`) | top-N preload + search |
| `sync_requests` | UNIQUE (`request_uuid`); (`processed_at`) | idempotency + pruning |
| `audit_logs` | (`subject_type`,`subject_id`,`occurred_at`); (`pos_session_id`,`occurred_at`) | audit UI |
| `session_sales_summaries` | (`pos_session_id`, `is_refund`); (`tax_signature`) | export & report |
| `media_files` | (`model_type`,`model_id`,`collection`,`sort_order`); (`checksum`) | image resolution, dedupe |

### 6.3 Delta-scan strategy
- Put `updated_at` **first** in a composite `(updated_at, company_id)` index on the high-churn
  syncable tables (`pos_orders`, `pos_order_lines`, `pos_payments`,
  `restaurant_order_courses`, `products`, `product_variants`, `pricelist_items`) so a delta is an
  index range scan, not a filtered table scan. For single-company deployments a plain
  `(updated_at)` index is enough.
- Use **millisecond precision** timestamps (`timestamp(3)`) and a **strictly greater than**
  comparison, with the server returning its own clock as the next watermark. Never use the client
  clock as a watermark.
- Guard against the "same-millisecond straddle" by returning `server_time = now() - 1s` on the
  bootstrap response (a one-second overlap re-sends a few rows; uuid upserts make that harmless).
- Cache the whole bootstrap payload per `(config_id, config_revision, profile)` in Redis; it is
  identical for every device on a register. Invalidate on `config_revision` bump. Only the
  order/session/device slice is per-device and must bypass the cache.

### 6.4 Write-path notes
- Order sync runs in **one transaction per order** (not per batch) so a single bad order cannot
  block the queue. Order-level lock: `SELECT … FROM pos_orders WHERE uuid = ? FOR UPDATE` before
  the upsert.
- Line/payment/course upserts use `INSERT … ON CONFLICT (uuid) DO UPDATE` (PG) /
  `INSERT … ON DUPLICATE KEY UPDATE` (MySQL) — this is what makes an offline retry a no-op and
  reproduces Odoo's "rewrite CREATE commands into UPDATE when the uuid already exists".
- Table-order race: rely on the partial index + a `SELECT … FOR UPDATE` on
  `pos_orders WHERE restaurant_table_id = ? AND state='draft'`; on collision, merge into the
  oldest order and record a `pos_order_merges` row (never raise to the cashier).
- Preparation snapshot writes use `order_preparation_snapshots.server_version` as an optimistic
  lock: `UPDATE … SET snapshot=?, server_version=server_version+1 WHERE pos_order_id=? AND
  server_version=?`; zero rows affected ⇒ respond `409` "Order Outdated" and return the server
  snapshot (Odoo's `metadata.serverDate` check, made race-free).
- Denormalised counters (`pos_orders.unsent_change_count`, `pos_sessions.order_count`,
  `customers.order_count`, `restaurant_floors.table_count`, `products.attribute_count`) are updated
  in the same transaction as their source rows, never by trigger, and are rebuilt by a nightly
  reconciliation command.
- Session close is a single serialisable transaction: lock the session row, assert zero draft
  orders (excluding future-`preset_time` ones, which are detached to the next session), write
  `session_payment_totals` + `session_sales_summaries` + `session_tax_summaries` + the `difference`
  cash movement, flip orders `paid → done`, then set `state = 'closed'`.

### 6.5 Partitioning & retention (only when volume demands it)
- `pos_orders`, `pos_order_lines`, `pos_payments`: partition by `RANGE (ordered_at)` monthly once
  past ~20 M lines. All hot queries carry a config + date predicate, so pruning works.
- `audit_logs`, `sync_requests`, `prep_line_stage_logs`, `notification_logs`: monthly partitions
  with a drop-old-partition job (`pos.sync_retention_days`, `pos.audit_retention_days`).
- `preparation_print_jobs`: delete `printed` rows older than 7 days.
- Never partition or prune `pos_sessions`, `session_*_summaries`, `pos_invoices` — they are the
  fiscal record.

### 6.6 Broadcast (no tables, but it shapes the schema)
Channel names derive from tokens already in the schema, so no extra state is needed:
- `pos-config.{pos_configs.access_token}` — `order.synced`, `order.removed`, `session.closing`,
  `customer_display.update`, `product.changed` (fan-out includes `pos_config_trusted_config` peers).
- `pos-order.{pos_orders.access_token}` — self-order status, payment result.
- `prep-display.{prep_displays.access_token}` — KDS board events.
Payloads carry **ids/uuids only** where trust matters (mirroring Odoo's
`ONLINE_PAYMENTS_NOTIFICATION` design); the client re-fetches authoritative data over HTTP.

---

## 7. Migration file ordering

Create migrations in this order so every `constrained()` call resolves. Tables with mutual FKs
(`companies.default_customer_id` ↔ `customers.company_id`;
`pos_configs.default_preset_id` ↔ `pos_presets`; `products.image_media_id` ↔ `media_files`) get the
FK added in a **later `*_add_deferred_foreign_keys` migration**, not inline.

```
001 currencies, currency_rates, countries, country_states, languages, decimal_precisions
002 companies (without default_customer_id FK), settings
003 media_files, users, roles, permissions, permission_role, role_user
004 uom_categories, uoms
005 tax_groups, taxes, tax_children
006 fiscal_positions, fiscal_position_taxes, cash_roundings
007 product_categories, pos_categories, product_tags
008 products, product_variants, product_packagings
009 product_tax, product_variant_tax, pos_category_product, product_tag_product,
    product_optional_products
010 product_attributes, product_attribute_values, product_attribute_lines,
    product_attribute_line_values, product_variant_attribute_value, product_attribute_exclusions
011 combos, combo_items, combo_product
012 pricelists, pricelist_items
013 barcode_nomenclatures, barcode_rules
014 customers, employees
015 payment_providers, payment_methods, notification_templates
016 pos_presets, preset_service_windows, pos_notes, pos_bills, pos_printers,
    pos_category_pos_printer
017 restaurant_floors, restaurant_tables
018 prep_displays, prep_stages
019 self_order_custom_links
020 loyalty_programs, loyalty_rules, loyalty_rewards, loyalty_cards + all loyalty pivots
021 pos_configs
022 all pos_config_* pivots, sequences, pos_config_employee, pos_devices
023 pos_sessions
024 pos_orders, pos_order_lines, pos_order_line_attribute_value,
    pos_order_line_custom_attribute_values
025 payment_transactions, pos_payments
026 pos_invoices, pos_invoice_lines
027 restaurant_order_courses, pos_order_merges  (+ add pos_order_lines.restaurant_course_id FK)
028 order_preparation_snapshots, prep_orders, prep_order_lines, prep_line_stage_logs,
    preparation_print_jobs
029 cash_movements, session_cash_counts, session_cash_count_lines, session_payment_totals,
    session_sales_summaries, session_tax_summaries, accounting_exports,
    accounting_export_session
030 loyalty_card_histories, pos_order_loyalty_points, loyalty_communications
031 audit_logs, pos_order_edit_logs, sync_requests, sync_conflicts, notification_logs
032 add_deferred_foreign_keys (companies.default_customer_id, companies.logo_media_id,
    pos_configs.default_preset_id / tip_product_id / global_discount_product_id /
    self_order_online_payment_method_id, products.image_media_id, employees.avatar_media_id, …)
033 add_partial_and_composite_indexes (everything in §6.2 that Laravel does not create implicitly;
    partial indexes via DB::statement for Postgres, generated-column workaround for MySQL)
```

### 7.1 Seeders required for a bootable system
`currencies`, `countries`/`country_states`, `languages`, `decimal_precisions`
(`Product Price`=2, `Product Unit of Measure`=3, `Discount`=2, `Payment Terminal`=2),
`uom_categories`+`uoms` (Units, kg, g, L, hour), `roles`+`permissions`+`permission_role`,
default `barcode_nomenclatures`+`barcode_rules`, the three system `pos_presets`
(Dine In / Takeaway / Delivery, `is_system = true`), the special products
(`special_kind = tip` / `global_discount`), a default `tax_group` + company tax, one
`pos_config` with a cash + card `payment_method`, one `restaurant_floor` with one
`restaurant_table` (Odoo's `_setup_default_floor`), and default `notification_templates`
(receipt email, receipt SMS, self-order confirmation).

---

## 8. Deliberate deviations from Odoo (summary for reviewers)

| # | Deviation | Reason |
|---|---|---|
| 1 | No double-entry accounting; `session_*_summaries` + `accounting_exports` instead | The product is a POS, not a ledger. Summaries are lossless for export purposes. |
| 2 | No stock/inventory module; optional `on_hand_qty` counter | Restaurant POS parity does not require WMS; pickings were the single largest source of Odoo POS closing failures. |
| 3 | KDS (`prep_*`) added, which Odoo has only in Enterprise | The brief requires a preparation display; the printer path is kept at community parity alongside it. |
| 4 | `order_preparation_snapshots.server_version` optimistic lock replaces `metadata.serverDate` string compare | Removes a real multi-device race. |
| 5 | `pos_order_merges` persists merge/unmerge/split bookkeeping that Odoo kept in volatile client state | Correctness across devices and refreshes. |
| 6 | `session_cash_counts` + lines (denomination-level counting) | Odoo stored only the total; variance investigation needs the breakdown. |
| 7 | `sequences` table replaces `ir.sequence`; `sync_requests` adds batch-level idempotency | Simpler, and makes retries provably safe. |
| 8 | Roles/permissions flattened; per-config employee access levels kept | Odoo's group graph + ACL rows + record rules are far more machinery than a POS needs. |
| 9 | `pos_categories` gets a materialised `path`; `products` gets denormalised `attribute_count`/`combo_count`/`has_image` | Removes N+1 work from the bootstrap serializer. |
| 10 | Tax/pricelist/variant/combo/barcode/fiscal-position modelling kept at **full** Odoo fidelity | Tax and price maths must match to the cent; this is the part that is expensive to get wrong. |
