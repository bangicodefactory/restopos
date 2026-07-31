# SPEC-02 — Feature Parity Matrix
## Laravel + Inertia + React + PWA rewrite of Odoo 19 Restaurant POS

**Status:** Draft 1 — derived from the five Odoo 19 source inventories
(`01-pos-backend.md`, `02-pos-frontend.md`, `03-pos-restaurant.md`, `04-self-order.md`, `05-backoffice-aux.md`).

**Purpose.** This document is the authoritative list of *what we build*. Every leaf feature has a stable ID
that is referenced by the roadmap (§9), by the data-model spec, by tickets, and by test plans. IDs never get
renumbered; deleted features are marked `WITHDRAWN` in place; new features take the next free number in the
reserved block.

---

## 0. How to read this document

### 0.1 ID scheme

| Prefix | Area | Block reservation |
|---|---|---|
| `REG-nnn` | Register (cashier) app | 001–299 |
| `RST-nnn` | Restaurant (floors, tables, courses, bills, tips) | 001–199 |
| `KDS-nnn` | Kitchen — preparation display + preparation printing | 001–099 |
| `SLF-nnn` | Self-order (QR menu, table self-order, kiosk, online payment) | 001–149 |
| `BOF-nnn` | Back-office (admin, configuration, reporting) | 001–199 |
| `XCT-nnn` | Cross-cutting (offline, realtime, hardware, i18n, tenancy, audit) | 001–149 |

Numbers are allocated in sub-blocks with gaps so related features can be inserted later without renumbering.

### 0.2 Priority

| Value | Meaning |
|---|---|
| **P0** | Core. The product is not shippable to a single restaurant without it. |
| **P1** | Important. Needed for a competitive product / needed by most sites; can ship after first pilot. |
| **P2** | Nice-to-have. Differentiator, niche, or long-tail parity item. |

### 0.3 Complexity

| Value | Rough engineering size (1 dev, includes tests) |
|---|---|
| **S** | ≤ 1 day |
| **M** | 2–4 days |
| **L** | 1–2 weeks |
| **XL** | > 2 weeks, or needs its own design doc |

### 0.4 Conventions used by the whole spec

- **Odoo ref** columns cite the module + file/model from the inventories, e.g. `point_of_sale/models/pos_session.py :: set_opening_control`.
- "Parity note" flags behavior that is subtle, undocumented, or easy to get wrong. Treat each parity note as a
  mandatory acceptance-test case.
- Where Odoo's implementation is an artifact of its ORM/accounting engine rather than a user-visible behavior,
  the parity note says so and points at §8 (out of scope) or at the simplification we adopt.
- **Terminology mapping** used throughout: Odoo `pos.config` → *register*; `pos.session` → *session/shift*;
  `pos.order` → *order/ticket*; `pos.order.line` → *order line*; `restaurant.floor/table` → *floor/table*;
  `pos.preset` → *service mode* (Dine-in / Takeaway / Delivery); `pos.printer` → *prep station printer*;
  `pos.prep.*` (enterprise) → *KDS*.

---

# 1. REG — Register (cashier) app

The register is a React SPA served by Inertia, mounted once, then running as a PWA against a local
IndexedDB replica. Everything in §1 must work with the network down unless the parity note says otherwise.

## 1.1 Session lifecycle & cash control (REG-001 … REG-039)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-001 | Open register: create or resume a session for a register config, land the cashier in the app | `pos.config.open_ui`, `controllers/main.py GET /pos/ui/<id>` | P0 | M | Odoo takes a `FOR UPDATE NOWAIT` row lock on the config so two devices cannot create two sessions in the same millisecond. Reproduce with a DB lock or a unique partial index on `(register_id) WHERE state <> 'closed' AND NOT rescue`. |
| REG-002 | Pre-open validation of the register configuration | `pos.config._check_before_creating_new_session` | P0 | S | Odoo blocks opening on: no payment method, payment-method/journal currency mismatch, cash journal missing P&L accounts, no fiscal country. Our equivalent: ≥1 payment method, all methods in register currency, tax profile set. Failures must be *actionable* messages, not a 500. |
| REG-003 | Opening control screen: enter opening cash float, confirm to move session to `opened` | `pos.session.set_opening_control` | P0 | M | Session `name`/number is assigned **at opening control**, not at create. An abandoned opening-control session must not burn a session number. |
| REG-004 | Pre-fill opening float from previous session's counted closing cash | `pos.session.action_pos_session_open` | P1 | S | Prefill only; the cashier can override. The delta between prefill and entered value is logged (REG-024). |
| REG-005 | Denomination counter (coins/bills grid computing a total) for opening and closing counts | `MoneyDetailsPopup` + `pos.bill` | P1 | M | Denominations are per-register or global (`pos.bill.pos_config_ids` empty = all). Counting must also be usable to *partially* count (blank rows = 0). Opens the cash drawer when invoked. |
| REG-006 | Opening notes free-text stored on the session | `pos.session.opening_notes` | P2 | S | Appears in the session report's "Session Control" block (BOF-165). |
| REG-007 | Abandon an unopened session (leave without opening) | `delete_opening_control_session` + `navigator.sendBeacon` on `beforeunload` | P2 | S | Odoo deletes the session on tab close via a beacon. Do the same, and additionally reap `opening_control` sessions with no orders older than N hours in a scheduled job — beacons are unreliable. |
| REG-008 | Session state machine `opening_control → opened → closing_control → closed` | `pos.session.state` | P0 | M | State is also read by every other device (REG-245). No transition may skip a state; `closed` is terminal. |
| REG-009 | Exactly one non-closed, non-rescue session per register | `pos.session._check_pos_config` | P0 | S | Enforce in DB, not only in app code — offline devices race. Rescue sessions are exempt. |
| REG-010 | Cash in / cash out with amount + mandatory reason (+ optional customer/employee attribution) | `pos.session.try_cash_in_out` | P0 | M | Signed amount: "out" is stored negative. Queued when offline and replayed in order (XCT-006). Feeds the closing expected-cash computation. |
| REG-011 | Delete a cash movement, permission-gated | `delete_cash_in_out`, `_has_cash_delete_permission` | P1 | S | Odoo gates create and delete with *different* permissions. Keep two distinct abilities: `cash-move.create`, `cash-move.delete`. Deletion is logged. |
| REG-012 | Cash movement list for the current session | `get_cash_in_out_list` | P2 | S | Shown in the closing popup and standalone. Must show attribution (who) once employees exist (REG-047). |
| REG-013 | Cash movement receipt printing | `CashMoveReceipt` | P2 | S | Printed on the receipt printer; opens the drawer. |
| REG-014 | Closing control data: expected cash breakdown + per-method expected totals + counts | `pos.session.get_closing_control_data` | P0 | M | Expected cash = opening float + cash payments + cash in/out. Must be computed **server-side** from synced orders, never from the local replica, or two devices will disagree. Returns `is_manager` and the authorized difference so the client can gate. |
| REG-015 | Closing screen: counted cash + counted amount per non-cash method + difference display | `ClosePosPopup` | P0 | M | Non-cash counted amounts are pre-filled with expected and auto-fillable; a per-method difference is carried into the accounting summary. Odoo shows a warning when orders exist for future dates (presets). |
| REG-016 | Enforce max authorized cash difference for non-managers | `set_maximum_difference` + `amount_authorized_diff` | P1 | S | Client-side gate driven by server data. A manager override path must exist (re-auth by PIN, REG-042). |
| REG-017 | Close session: flush pending orders, mark orders final, freeze totals, produce the session summary | `close_session_from_ui` → `_validate_session` | P0 | L | Refuses if draft orders remain for *today*; draft orders with a **future** `preset_time` are detached and survive into the next session — do not delete them. A second concurrent close must not corrupt: route late orders into a rescue session (REG-021). |
| REG-018 | Cash over/short recorded as an explicit adjustment line on the session | `_post_statement_difference` | P1 | M | We record it as a first-class `cash_adjustment` row on the session, not a journal entry (see §8.1). Sign convention: positive = surplus in drawer. |
| REG-019 | Closing notes | `update_closing_control_state_session(notes)` | P2 | S | |
| REG-020 | Download/print the session sales report from the closing screen | `sale_details_report` | P1 | S | Same report as BOF-165; must be printable to the receipt printer *and* downloadable as PDF. |
| REG-021 | Rescue session: auto-created session that absorbs orders pushed after their session closed | `pos.session.rescue`, `_get_valid_session` | P1 | M | Not creatable by hand, not closable from the register, counted cash auto-derived. Without this, an offline device that reconnects after closing loses orders — the single most damaging failure mode in the whole system. |
| REG-022 | Broadcast "session closing" to sibling devices; they flush and reload | bus `CLOSING_SESSION` | P1 | M | Receiving devices must push their paid orders **before** reloading, and mark local drafts cancelled. |
| REG-023 | Stale-session alert (session open > N days) | `pos.session._alert_old_session` (cron) | P2 | S | Notification to managers, not a hard block. |
| REG-024 | Session event log (opening/closing differences, drawer opens, cancelled actions, cash-move deletes) | `log_partner_message`, chatter messages | P1 | M | Odoo uses the chatter; we build a typed `session_events` table. Feeds XCT-120 audit trail. |

## 1.2 Cashier identity, roles & permissions (REG-040 … REG-059)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-040 | Login screen: pick the cashier before selling | `LoginScreen`, `pos_hr` | P0 | M | With employee login disabled the screen is a single "Open register" button; do not special-case it away, other screens navigate back to it. |
| REG-041 | Badge / barcode cashier login | `pos_hr` `_barcode` (SHA-1 hashed to client) | P1 | M | Odoo ships **hashes** to the client so badge numbers never sit in browser storage. Do the same (HMAC with a per-session salt is better). Comparison happens offline. |
| REG-042 | PIN cashier login | `pos_hr` `_pin` (SHA-1 hashed) | P1 | S | Same hashing rule. PIN is also the manager-override mechanism (REG-016, REG-045). |
| REG-043 | Employee roles: manager / cashier / minimal | `pos_hr` `_role`, `group_pos_manager` | P0 | M | Three levels, not two. "minimal" is a stripped UI (no ticket list, no refunds) intended for runners. Role is resolved client-side from loaded data so it works offline. |
| REG-044 | Per-register employee allow-lists (advanced / basic / minimal) | `pos.config.{advanced,basic,minimal}_employee_ids` | P1 | M | Odoo rule: **all three lists empty ⇒ every employee may log in**. Lists are mutually exclusive; POS managers cannot be demoted out of "advanced". |
| REG-045 | Manager-only gates in the register (price edit, payment edit, reprint-after-print, close, product create, discount above threshold) | `restrict_price_control`, `canEditPayment` | P0 | M | Gates are *client-enforced* using server-provided flags. Server must re-validate the same rules on sync, otherwise a modified client can bypass them. |
| REG-046 | Cashier stamped on every order and line; re-owning empty orders on cashier switch | `pos.order.employee_id`, per-line stamping | P1 | S | Odoo re-owns an *empty* order to the new cashier but keeps ownership once lines exist. |
| REG-047 | Cashier attribution on cash movements | `account.bank.statement.line.employee_id` | P2 | S | |
| REG-048 | Cashier persisted per register across reloads | `sessionStorage connected_cashier_<configId>` | P1 | S | Session storage, not local storage — a new tab must re-login. |
| REG-049 | Idle screensaver + auto-logout (5 min general / 2 min on login screen) | `SaverScreen`, idle timer in `Chrome` | P2 | S | Restaurant overrides this to return to the floor plan after 3 min (RST-014). |
| REG-050 | Employee action log (drawer opened, action cancelled, override used) | `log_partner_message` | P2 | S | |

## 1.3 Product catalog: browse, search, scan (REG-060 … REG-099)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-060 | Category rail with hierarchical drill-down; clicking the selected category goes *up* one level | `CategorySelector`, `pos.category.parent_id` | P0 | M | Odoo's "click selected = go up" is unintuitive but muscle-memory for existing users; keep it and add a breadcrumb. |
| REG-061 | Category images and colors | `pos.category.image_512`, `color`, `show_category_images` | P1 | S | |
| REG-062 | Restrict register to a subset of category trees | `limit_categories` + `iface_available_categ_ids` | P1 | S | Restriction must also include categories referenced by prep printers, otherwise kitchen routing silently breaks. |
| REG-063 | Category availability time windows (`hour_after`/`hour_until`) | `pos.category.hour_after/hour_until` | P2 | S | Used mainly by self-order; apply it in the register too for consistency (breakfast menu). |
| REG-064 | Product grid/list with image, name, price | `ProductCard` | P0 | M | Price shown incl. or excl. tax per `iface_tax_included`. Rendering cap of 100 items — keep a cap (virtualized list is better) or the grid janks on 5000 products. |
| REG-065 | Product ordering: favorites first, then `pos_sequence`, then name | `is_favorite`, `pos_sequence` | P1 | S | |
| REG-066 | Optional grouping of the grid by category | `iface_group_by_categ` | P2 | S | |
| REG-067 | Cart-quantity badge on product cards | `ProductCard` | P2 | S | |
| REG-068 | Instant local search over name / internal ref / barcode (normalized, accent-insensitive) | `pos.searchProductWord`, `product.searchString` | P0 | M | Odoo builds one concatenated normalized `searchString` per product at load. Do the same (or a client-side inverted index); per-keystroke `filter()` over 5000 products with `toLowerCase` is too slow on cheap Android terminals. |
| REG-069 | Server-side product search fallback (Enter key), paginated | `product.template.load_product_from_pos` | P1 | M | Needed because only N products are preloaded. Results merge into the local store and become searchable offline afterwards. |
| REG-070 | Limited product loading with a configurable cap + "load everything" escape hatch | `limited_product_count` (5000), `?limited_loading=0` | P1 | M | Odoo's selection SQL is *ordered*: favorites → services → recently moved stock → recently written. Reproduce the ordering, not just the limit, or the wrong 5000 get cached. |
| REG-071 | Lazy product fetch on barcode miss | `load_product_from_pos` by barcode | P1 | S | Must degrade gracefully offline: show "unknown product, connect to look it up". |
| REG-072 | Product info panel: price breakdown, taxes, margin/cost, stock per location, supplier, variants, per-pricelist prices | `get_product_info_pos`, `ProductInfoPopup` | P1 | L | Margin/cost visibility gated by `is_margins_costs_accessible_to_every_user`. The tax/margin part must be computed locally so the popup still opens offline; only stock/supplier need the server. |
| REG-073 | Product configurator: attribute selection (radio / pills / select / color / multi), custom free-text values, per-value price extras, exclusion rules | `ProductConfiguratorPopup`, `product.template.attribute.*` | P0 | L | `product.template.attribute.exclusion` must be honored *live* (disable impossible combinations as you select). `is_custom` values need a text input whose value rides on the line. |
| REG-074 | Create a product variant on the fly for dynamic-variant attributes | `create_product_variant_from_pos` | P2 | M | Requires network. Offline: block with a clear message. |
| REG-075 | Combo configurator with free/extra quantity semantics | `ComboConfiguratorPopup`, `product.combo.qty_free/qty_max` | P0 | L | The combo price split (`computeComboItems`) distributes the parent price across children proportionally to each item's `base_price`, then pushes rounding remainder onto the last line. Any deviation breaks receipts, invoices, and the closing report. Port the algorithm literally and unit-test it against Odoo fixtures. |
| REG-076 | Lot / serial number selection per line | `SelectLotPopup`, `pos.pack.operation.lot`, `get_existing_lots` | P2 | L | Availability is checked against other *draft* orders too. Barcode-embedded lots bypass the popup. We ship this only if the pilot needs traceability — see §8.2. |
| REG-077 | Weighed products via electronic scale | `ScaleScreen`, `to_weight`, `iface_electronic_scale` | P1 | M | LNE/legal-metrology rule Odoo implements: the weight **must change** between two consecutive weighings, else the second is refused. Keep it — it is a legal requirement in FR/BE. |
| REG-078 | Optional / cross-sell product suggestions after adding a product | `pos_optional_product_ids`, `OptionalProductPopup` | P2 | M | |
| REG-079 | Quick product create/edit from the register | `product_template_action_add_pos` (modal form) | P2 | M | Manager-gated, network-required. Defaults `available_in_pos = true`. |
| REG-080 | Barcode input via HID keyboard wedge | `barcode_reader_service`, keystroke timing | P0 | M | Timing-based detection: keystrokes faster than `maxTimeBetweenKeysInMs` are a scan, not typing. This interacts with the numpad buffer (REG-104) — get it wrong and scanning while a line is selected mangles quantities. |
| REG-081 | Barcode input via device camera | `BarcodeVideoScanner` (zxing) | P1 | M | Needs HTTPS + camera permission; must be toggleable and must release the camera when leaving the screen. |
| REG-082 | Barcode input via IoT/proxy scanner long-poll | `hw_proxy/scanner`, `iface_scan_via_proxy` | P2 | M | |
| REG-083 | Barcode nomenclature parsing: product, weight, price, discount, customer, cashier, lot rule types | `barcode.rule.type` POS extensions | P1 | L | Embedded-weight and embedded-price barcodes set the line quantity/price directly. Rules are prefix+length patterns with a check-digit position; a naive `startsWith` implementation will misparse. |
| REG-084 | GS1 composite barcode parsing (product + lot + quantity in one scan) | `BarcodeParser` GS1 | P2 | L | |
| REG-085 | Packaging barcodes (a barcode that means "6-pack of X") | `product.uom.barcode` | P2 | M | Scanning it adds the product with the packaging quantity multiplier. |
| REG-086 | Fallback nomenclature (secondary rule set per register) | `pos.config.fallback_nomenclature_id` | P2 | S | Try primary, then fallback, then raw-barcode lookup, then zero-stripped GTIN. |
| REG-087 | Leading-zero-stripped GTIN fallback lookup | client barcode handling | P2 | S | EAN-13 stored as UPC-A and vice versa; this fallback prevents daily "unknown product" calls. |
| REG-088 | Audible feedback: scan-ok beep, scan-error buzz, bell on input cap | `sound_effects` | P2 | S | Must respect a mute setting and must not require a user gesture after the first interaction. |
| REG-089 | Unknown-barcode notification with "search / create" affordance | `pos_store` barcode miss | P1 | S | |

## 1.4 Order lines & order operations (REG-100 … REG-149)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-100 | Add a product to the current order | `pos.addLineToCurrentOrder` | P0 | M | The full add pipeline is: refund guard → configurator → combo → lots → scale → price computation → **merge** → optional products. Order of steps matters; each can cancel the add. |
| REG-101 | Auto-merge compatible lines | `canBeMergedWith` | P0 | M | Merge requires: same product, same discount, same price type, same note, groupable UoM, not tracked (lots), not a refund line, not a combo, **and in restaurant: same course**. Any missing condition produces wrong kitchen tickets. |
| REG-102 | Set line quantity (UoM-rounded) | `setQuantity` | P0 | M | Rounding uses the product's UoM rounding *and* the "Product Unit" decimal precision. Quantity 0 makes the line removable but not auto-removed. |
| REG-103 | Set line discount percentage (0–100) | numpad `%` mode | P0 | S | Clamped. Gated by `manual_discount`. |
| REG-104 | Set line unit price manually; track `price_type` original/manual/automatic | numpad price mode, `price_type` | P0 | M | `price_type` decides whether a pricelist change (REG-111) recomputes the line. Manual prices survive; automatic ones are recomputed. |
| REG-105 | Numpad: digits, decimal, sign toggle, backspace, mode keys | `Numpad`, `NumberBuffer` | P0 | L | The buffer is a per-screen *stack* of holders, is barcode-aware (delays handling by the scanner inter-key time), localizes the decimal separator, caps at 12 digits with an audible bell, and treats **backspace on an empty buffer as "remove line"**. These micro-behaviors are what cashiers actually feel. |
| REG-106 | Line select / deselect; long-press to re-open the configurator or combo editor | `OrderSummary`, `Orderline` | P1 | M | Editing is blocked once the line was sent to the kitchen (KDS-052). |
| REG-107 | Reducing quantity below the already-sent quantity creates a compensating negative line instead of editing | `OrderSummary` decrease-quantity flow | P1 | M | This exists so the kitchen gets a "cancel 1×" ticket rather than a silent edit. Easy to miss; it changes the shape of the order. |
| REG-108 | Remove a line (guarded for sent/refund/tip lines) | `Orderline` delete | P0 | S | |
| REG-109 | Per-line customer note (prints on the customer receipt) | `pos.order.line.customer_note` | P1 | S | |
| REG-110 | Per-line internal/kitchen note with predefined note chips | `pos.order.line.note`, `pos.note`, `note_ids` | P0 | M | Stored as a **JSON array of `{text, colorIndex}`**, not a plain string. Note-only changes trigger their own kitchen ticket type (KDS-021). |
| REG-111 | Order-level customer note and internal note | `general_customer_note`, `internal_note` | P1 | S | Order-level note changes print a header-only kitchen ticket. |
| REG-112 | Combo parent/child line structure with propagation of quantity and course | `combo_parent_id`, `combo_line_ids` | P0 | M | Children follow the parent for quantity, course, deletion and refund; children cannot be priced individually. |
| REG-113 | Full display name including selected attributes | `full_product_name` | P1 | S | Persisted on the line so old receipts still render after a product is renamed. |
| REG-114 | Order totals: subtotal, per-tax-group breakdown, total, total discount | `get_tax_totals_summary` | P0 | M | Cached per order with a dirty flag, recomputed once per mutation batch — recomputing on every keystroke over a 60-line order is visibly slow. |
| REG-115 | Order reference generation `YY<device>-<register>-<seq>` | `pos.config._get_next_order_refs` | P0 | M | Per-**device** sequence namespace (`DeviceIdentifierSequence` in localStorage with unused-number recycling) is what makes offline multi-device numbering collision-free. Do not centralize it. |
| REG-116 | Short customer-facing tracking number (seq mod 1000) | `pos.order.tracking_number` | P0 | S | Displayed large on receipts and on the KDS. Wraps at 1000 — accept collisions across days, not within a session. |
| REG-117 | 5-character ticket code for portal invoice self-service | `pos.order.ticket_code` | P2 | S | |
| REG-118 | Client-generated order/line/payment UUIDs as idempotency keys | `uuid` unique columns | P0 | M | Unique constraint at DB level. This is the backbone of offline retry safety (XCT-010). |
| REG-119 | Multiple parallel draft orders with tabs ("floating orders") | `OrderTabs`, `floating_order_name` | P0 | M | Each order remembers its own current screen (`uiState.screen_data`) and is restored to it when re-selected. |
| REG-120 | Name / rename a floating order | `EditOrderNamePopup` | P1 | S | The popup also lists other floating orders as merge targets (RST-052). |
| REG-121 | Save/park the current order and start a new one | `clickSaveOrder` | P0 | S | Syncs, then opens an empty order. |
| REG-122 | Cancel an order (with guards) | `action_pos_order_cancel`, `remove_from_ui` | P0 | M | Draft-only. Cancelling must notify other devices *and* cancel pending kitchen changes. Orders with a future preset time cannot be cancelled. |
| REG-123 | Order edit tracking: flag edited orders and deleted lines | `order_edit_tracking`, `is_edited`, `has_deleted_line` | P1 | M | Config-gated audit feature used for fraud detection. Log line deletions and quantity decreases with before/after values. |
| REG-124 | Payment-change audit log on an order | `_create_pm_change_log` | P2 | S | |
| REG-125 | Per-order screen state restoration across order switches | `order.uiState` | P1 | M | Must be persisted in IndexedDB with the order, otherwise a refresh mid-payment loses context. |

## 1.5 Customer management (REG-150 … REG-169)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-150 | Customer list dialog with instant local search | `PartnerList` | P0 | M | Local search covers name, phone, email, ref, VAT, zip via a concatenated `searchString`. |
| REG-151 | Server-side customer search with infinite-scroll paging | `res.partner.get_new_partner` | P1 | M | Odoo selects the search *field* based on the input shape (digits → phone/mobile/barcode/VAT/zip; otherwise name). Offset cache is kept per search term. |
| REG-152 | Preload the top-N customers by order count | `_get_limited_partner_count` (100), raw SQL ordering | P1 | M | The *ordering* matters: regulars must be offline-available. |
| REG-153 | Create a customer from the register | backend form dialog (`res_partner_action_edit_pos`) | P0 | M | Odoo requires network here. We should support **offline create** with a client UUID and reconcile on sync — a genuine improvement, but it needs a duplicate-merge story. |
| REG-154 | Edit a customer from the register | same | P1 | M | |
| REG-155 | Assign a customer to the order → recompute pricelist and fiscal position | `updatePricelistAndFiscalPosition` | P0 | M | Partner's pricelist only applies if it is in the register's allowed list. Companies auto-enable invoicing. |
| REG-156 | Customer barcode / loyalty card scan to identify a customer | barcode rule type `client` | P2 | S | |
| REG-157 | Customer required by context (split payment, invoice, ship-later, preset identification) | `OrderPaymentValidation` pre-checks | P0 | S | Enforce at validation time with a jump-to-customer-picker, not a dead-end error. |
| REG-158 | Blocked: changing the customer on an order that already contains refund lines | `PartnerList` guard | P1 | S | |
| REG-159 | Jump from a customer to their order history | `PartnerLine` orders shortcut | P2 | S | |

## 1.6 Pricing, taxes, discounts (REG-170 … REG-199)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-170 | Client-side pricelist engine: rule resolution variant → template → category (walking parents) → global | `product_pricelist.js`, `product.pricelist.item` | P0 | L | Also: `min_quantity` best-rule selection, date windows, and **recursive** `base_pricelist_id` resolution. Build the rule index at load; a linear scan per line is too slow. |
| REG-171 | Pricelist compute types: fixed, percentage, formula (discount %, rounding, surcharge, min/max margin) | `compute_price` variants | P1 | M | The formula mode has five interacting parameters; unit-test the combinations against Odoo output. |
| REG-172 | Pricelist ↔ register currency conversion | `_convert_pos_data_currency` | P2 | S | |
| REG-173 | Switch the pricelist on an open order and recompute all non-manual lines | `ControlButtons` pricelist selector | P1 | M | Combos must be **re-split**, not just re-priced. |
| REG-174 | Tax engine parity: price-included and price-excluded taxes, tax groups, children taxes, base-affecting taxes, negative factors, per-line and per-document rounding modes | `@account/helpers/account_tax` ported to both client and server | P0 | XL | This is the single highest-risk item in the project. Client and server must produce **byte-identical** totals; the server recomputes and is authoritative (`_compute_prices`, "we don't trust the client"). Build a shared test corpus (JSON fixtures of line sets → expected totals) that runs in both PHP and TS in CI. |
| REG-175 | Fiscal positions (tax mapping) from register default, partner, preset, or manual selection | `account.fiscal.position.tax_map` | P1 | M | Precedence order is: manual > preset > partner (if allowed) > register default. Applies to price display *and* to the invoice. |
| REG-176 | Cash rounding (global or cash-only) with rounding strategies | `account.cash.rounding`, `only_round_cash_method` | P1 | M | Affects remaining due, change, default payment amounts, and the fully-paid tolerance (`±rounding/2` for HALF-UP, `±rounding` otherwise). Getting the tolerance wrong makes orders un-payable. |
| REG-177 | Decimal precision handling for prices and quantities | `decimal.precision` | P0 | S | Two independent precisions (Product Price / Product Unit). Zero-comparisons must use the precision, never `=== 0`. |
| REG-178 | Per-line manual discount | `manual_discount`, `pos.order.line.discount` | P0 | S | |
| REG-179 | Global order discount (one negative line per tax group) | `pos_discount`, `prepare_global_discount_lines` | P1 | L | Odoo creates **one discount line per tax combination** so tax totals stay correct, and recomputes them reactively on every order change while draft. A single flat discount line is *not* equivalent and breaks tax reporting. |
| REG-180 | Discount display: original price strike-through and implied-discount heuristics | `without_discount` display policy | P2 | M | |
| REG-181 | Total-discount aggregate on the order and receipt | `getTotalDiscount` | P2 | S | |
| REG-182 | Price control: only managers may change prices | `restrict_price_control` | P1 | S | Numpad price mode falls back to quantity mode for non-managers. |
| REG-183 | Margin/cost visibility toggle | `is_margins_costs_accessible_to_every_user` | P2 | S | |
| REG-184 | Loyalty / promotions / coupons / gift cards / eWallet | `pos_loyalty` + `loyalty` | P2 | XL | Very large surface (programs, rules, rewards, cards, points, communication plans). Deferred to a post-1.0 module; design the order-line model now with `is_reward_line`, `reward_id`, `coupon_id`, `points_cost` columns reserved so we do not migrate later. |

## 1.7 Payments (REG-200 … REG-239)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-200 | Payment screen: method list, payment lines, totals, remaining, change | `PaymentScreen` | P0 | L | |
| REG-201 | Auto-select the only configured payment method | `PaymentScreen` mount | P1 | S | |
| REG-202 | Adding a method pre-fills the remaining due (cash-rounded) | `getDefaultAmountDueToPayIn` | P0 | S | |
| REG-203 | Split payment across multiple methods/lines, each independently editable | multiple `pos.payment` lines | P0 | M | Entering more than the due amount is only permitted when a cash method exists (change is possible); otherwise it is an error. |
| REG-204 | Change computation and the automatic negative cash "change" payment | `_process_payment_lines`, `is_change` | P0 | M | The change line is created **server-side** and excluded from `amount_paid`. A client that creates it too produces double counting. Error if change is due but no cash method exists. |
| REG-205 | Quick-amount keys (+10 / +20 / +50) and numpad amount editing | `PaymentScreen` numpad | P1 | S | Denominations should be derived from the currency, not hardcoded. |
| REG-206 | Cash payment: open the drawer, allow change | `is_cash_count` | P0 | S | |
| REG-207 | Bank/card payment (manual, no terminal) | payment method `type = bank` | P0 | S | |
| REG-208 | Pay-later / customer account (on-account) | `type = pay_later`, `split_transactions` | P1 | M | Requires a customer. Produces an outstanding balance we must track (BOF-119). |
| REG-209 | Fast payment: one-click payment buttons on the product screen | `use_fast_payment`, `fast_payment_method_ids` | P1 | M | Excludes terminal and split methods. In restaurant mode it must still run the "unsent kitchen changes" prompt (RST-143). |
| REG-210 | Payment terminal integration interface (state machine: pending → waiting → done / retry / cancel / reverse / force-done) | `payment_interface.js`, `register_payment_method` | P1 | XL | Design as a driver registry from day one even if we ship only one driver. Refund orders must **not** auto-send to the terminal. |
| REG-211 | Auto-validate the order when the terminal reports paid | `auto_validate_terminal_payment` | P1 | S | |
| REG-212 | Terminal reversal / cancel of an in-flight payment | `PaymentScreenStatus` actions | P1 | M | Deleting a payment line with an in-flight terminal payment must cancel on the terminal first. |
| REG-213 | Terminal metadata captured on the payment (card brand, last-4, cardholder, auth code, transaction id, ticket text) | `pos.payment` terminal fields | P1 | S | The terminal's own ticket text is printed on the customer receipt. |
| REG-214 | Static/dynamic QR-code payment methods (bank transfer QR) | `payment_method_type = qr_code`, `get_qr_code`, `default_qr` | P2 | M | Falls back to a pre-generated amount-less QR when offline. Mirrored on the customer display. |
| REG-215 | Online payment: customer pays on their own phone via a QR to a hosted payment page | `pos_online_payment` | P2 | L | Server-authoritative: the payment line is created only from a confirmed transaction, never from the client. Cashier screen waits on a realtime notification. |
| REG-216 | Payment validation pre-checks | `OrderPaymentValidation` | P0 | M | Checks: customer required, cash rounding applied, empty-order rule, missing-lot confirmation, "no cash method ⇒ exact amount", large-overpay confirmation (>1000×), strip zero/pending payment lines and zero-qty lines. |
| REG-217 | Finalize: mark paid, timestamp, persist, sync, print, navigate | `OrderPaymentValidation.finalize` | P0 | L | On `ConnectionLost` it must **flush IndexedDB immediately** (bypassing the debounce) and continue to the receipt. Paying offline is a hard requirement. |
| REG-218 | Payments become immutable after the receipt is printed or the order is posted | `nb_print` guard, order state guard | P1 | S | |
| REG-219 | Payment methods removed from the register config are dropped from open orders on load | `PaymentScreen` mount cleanup | P2 | S | |
| REG-220 | Tip entry during payment (convert change to tip) | `pos.setTip` | P1 | M | Adds/updates a line on the configured tip product and sets `is_tipped`/`tip_amount`. Tip lines are protected from normal numpad edits. |

## 1.8 Receipts (REG-240 … REG-269)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-240 | Receipt content: logo, company block, header text, cashier, lines with attributes/notes/combos/lots, discounts with strike-through, per-tax-group subtotals, rounding line, total, payments, change, tracking number, date, reference, footer | `order_receipt.xml` | P0 | L | The receipt is the legal document in many jurisdictions — treat its layout as a versioned template with a snapshot stored per order so reprints are faithful. |
| REG-241 | Receipt screen with print / new order actions | `ReceiptScreen` | P0 | M | |
| REG-242 | Browser print fallback (`window.print`) | `printer_service` webPrintFallback | P0 | M | Must produce an 80mm-correct layout via CSS `@page`. |
| REG-243 | Network ESC/POS-over-ePOS printing (Epson) | `EpsonPrinter`, `epson_printer_ip` | P1 | L | Odoo renders HTML → canvas → **Floyd–Steinberg dithered monochrome raster** → ePOS XML. Also parses response status bits (paper out, cover open, near-end). Consider emitting native ESC/POS text commands instead of rasters for speed — but then the layout engine is ours to build. |
| REG-244 | IoT/proxy printer printing | `HWPrinter`, `hw_proxy/default_printer_action` | P2 | M | |
| REG-245 | Auto-print on validation, and skip-preview mode | `iface_print_auto`, `iface_print_skip_screen` | P1 | S | Skip-preview routes to the Feedback screen (REG-249). |
| REG-246 | Basic (price-less) receipt variant | `basic_receipt` | P2 | S | For gifts. |
| REG-247 | Reprint with `nb_print` counter | `nb_print` | P1 | S | Printing locks payment editing (REG-218). |
| REG-248 | Print failure retry dialog with per-printer error detail | `RetryPrintPopup` | P1 | M | |
| REG-249 | Feedback / "order done" screen when previews are skipped | `FeedbackScreen` | P2 | S | Finalization continues in the background; the screen auto-advances after 5 s. |
| REG-250 | Email the receipt (rendered image + optional invoice PDF) | `action_send_receipt`, `renderer.toJpeg` | P1 | M | Requires the order to be synced. Prefill from partner `invoice_emails`. |
| REG-251 | SMS the receipt | `pos_sms` | P2 | M | Text-only, no image. |
| REG-252 | Configurable receipt header/footer text (admin-only edit) | `receipt_header`, `receipt_footer`, `_check_header_footer` | P1 | S | Odoo restricts editing to admins — keep it, it is a compliance surface. |
| REG-253 | Ticket QR / portal URL on the receipt for self-service invoicing | `point_of_sale_use_ticket_qr_code`, display mode qr/url/both | P2 | M | |
| REG-254 | Offline-safe printing assets: logo cached as data URL, fonts awaited before render | `render_service` | P1 | S | Skipping the font wait produces receipts with fallback fonts and shifted columns. |

## 1.9 Refunds (REG-270 … REG-289)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-270 | Select refund quantities per line on the original order | `uiState.lineToRefund` | P0 | M | Refund bookkeeping lives on the **original** order, keyed by original line uuid, capped at `qty − refundedQty`. A single-line order auto-selects quantity 1. |
| REG-271 | Create the refund order: negative-quantity lines linked to the originals | `pos.order.refund()`, `refunded_orderline_id` | P0 | L | Copies price, discount, taxes, attributes and fiscal position; reuses an existing empty order when possible; jumps straight to payment. |
| REG-272 | Refunded-quantity tracking on original lines | `refunded_qty` computed | P0 | S | Must be derived from non-cancelled refund lines only. |
| REG-273 | Combo refunds propagate proportionally to children | refund flow | P1 | M | |
| REG-274 | Refund restrictions: no positive lines, no qty/discount/price edits, single source order | refund guards | P0 | S | Server also enforces "all refund lines reference one original order". |
| REG-275 | Refund of an invoiced order produces a credit note | `_prepare_invoice_vals` out_refund + reversal link | P1 | M | Auto-sets the invoice flag on the refund order. |
| REG-276 | Refund a full order in one action (from the ticket list) | TicketScreen refund entry | P1 | S | |
| REG-277 | Back-office refund from the order form | `pos.order.refund` action | P1 | M | Creates the refund in the *currently open* session of the same register; errors if none is open. |
| REG-278 | Refund with lot selection restricted to not-yet-refunded lots | refund lot handling | P2 | M | |
| REG-279 | Refund presets (`is_return`) that force negative quantities | `pos.preset.is_return` | P2 | S | |

## 1.10 Order list / ticket screen (REG-290 … REG-309)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-290 | Order list with two panes (list + detail) | `TicketScreen` | P0 | L | |
| REG-291 | Status filters: Active / Ongoing / Payment / Receipt / Paid(synced) | filter dropdown | P0 | M | "Ongoing/Payment/Receipt" are derived from each order's **stored screen**, not from a status column. |
| REG-292 | Search by reference, receipt number, invoice number, date, customer, cardholder, table | `SearchBar` fields | P0 | M | Local search uses fuzzy matching; the "Paid" filter builds a server query instead. |
| REG-293 | Server-side paid-order search with paging and local cache diffing | `search_paid_order_ids` (returns `[id, last_modified]`) + `read_pos_orders` | P1 | L | The two-step "ids+timestamps, then fetch only stale ones" pattern is what keeps this fast; reproduce it. |
| REG-294 | Reopen a draft order back onto its screen | order row activation | P0 | S | |
| REG-295 | Delete an order from the list (guarded, with kitchen cancellation) | delete button + `action_pos_order_cancel` | P1 | M | Hidden for finalized orders and orders with completed electronic payments. |
| REG-296 | Reprint receipt from the list | reprint action | P1 | S | |
| REG-297 | Reprint all kitchen changes for an order | `onClickReprintAll` | P1 | S | |
| REG-298 | Preset filter chips and preset-time lateness color coding | preset filters | P2 | M | |
| REG-299 | Find an order by scanning its receipt QR | QR scan → `order_uuid` | P2 | S | |
| REG-300 | Read-only detail pane with refund numpad and invoice button | detail pane | P0 | M | |
| REG-301 | Configurable page size for server-fetched orders | NumberPopup, default 30 | P2 | S | |

## 1.11 Invoicing (REG-310 … REG-324)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-310 | Invoice toggle at sale time (requires a customer) | `to_invoice` | P1 | M | Invoice is generated server-side during sync; the PDF is downloaded after. |
| REG-311 | Invoice an already-paid order from the ticket screen | `action_pos_order_invoice` | P1 | M | If the session is already closed, Odoo also creates a reversal entry to back the order out of the closing entry. We simplify (see §8.1) but must still keep the session summary consistent. |
| REG-312 | Invoice PDF generation and download/print | `_generate_pos_order_invoice` | P1 | L | Our invoice document is our own template; it must carry sequential legal numbering per company (XCT-121). |
| REG-313 | Reprint an existing invoice | `InvoiceButton` | P2 | S | |
| REG-314 | Batch invoicing of selected orders from the back office | `pos.make.invoice` | P2 | M | |
| REG-315 | Consolidated billing (group orders into one invoice per customer/register/user/fiscal position) | `consolidated_billing` | P2 | M | |
| REG-316 | Assign a missing customer during batch invoicing | `pos.confirmation.wizard` | P2 | S | |
| REG-317 | Customer self-service invoice request via receipt QR + ticket code | `/pos/ticket`, `/pos/ticket/validate` | P2 | L | Public form: receipt number + date + 5-char code; customer fills billing details and the invoice is issued. Rate-limit and constant-time compare the code. |

## 1.12 Ship later / deferred fulfilment (REG-325 … REG-334)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-325 | Ship-later toggle with a delivery date picker on the payment screen | `ship_later`, `shipping_date`, `DatePickerPopup` | P2 | M | Requires a customer. |
| REG-326 | Deferred delivery record created for ship-later orders | `_launch_stock_rule_from_pos_order_lines` | P2 | M | We create a lightweight `deliveries` record, not a stock picking (§8.2). |
| REG-327 | Simple stock decrement for storable products (real-time or at session close) | `update_stock_at_closing`, `_create_order_picking` | P2 | L | We implement a *single-location* quantity ledger only. Full multi-warehouse/lot/valuation is out of scope. |
| REG-328 | Negative-quantity (return) handling in the stock ledger | return picking creation | P2 | S | |

## 1.13 Presets / service modes & scheduling (REG-335 … REG-349)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-335 | Preset selection on an order (Dine-in / Takeaway / Delivery / custom) | `pos.preset`, `use_presets` | P0 | M | The preset drives pricelist, fiscal position, required customer info, and (in restaurant) whether a guest count is prompted. |
| REG-336 | Preset overrides the pricelist and fiscal position | `pos.preset.pricelist_id/fiscal_position_id` | P1 | S | Takeaway VAT rates depend on this in most of the EU — get the precedence right (REG-175). |
| REG-337 | Preset identification requirements (none / name / address) | `pos.preset.identification` | P1 | M | Enforced at payment validation; a "name only" preset must not force a full customer record. |
| REG-338 | Preset time slots: capacity per interval, availability computation | `use_timing`, `slots_per_interval`, `interval_time`, `get_available_slots` | P2 | L | Availability is computed from orders with `preset_time` in the last day. Offline the client falls back to a local estimate — accept possible over-booking. |
| REG-339 | Opening-hours calendar per preset | `resource_calendar_id`, `attendance_ids` | P2 | M | |
| REG-340 | `preset_time` on the order, lateness indicators, and the "cannot cancel a future order" rule | `preset_time` | P2 | M | Draft orders with a future preset time survive session closing (REG-017). |
| REG-341 | Return presets that flip the order to negative quantities | `is_return` | P2 | S | |

## 1.14 Customer display (REG-350 … REG-364)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-350 | Customer-facing display app: lines, totals, taxes, payments, change, idle screen | `customer_display/` standalone app | P1 | L | |
| REG-351 | Same-machine transport via BroadcastChannel (second monitor) | `BroadcastChannel("UPDATE_CUSTOMER_DISPLAY")` | P1 | S | Works offline — this must be the default path. |
| REG-352 | Remote-device transport via websocket, addressed by device UUID | `update_customer_display` + bus channel | P1 | M | Requires network; the URL carries a public access token compared in constant time. |
| REG-353 | IoT-proxy customer display variant | `hw_proxy/customer_facing_display` polling | P2 | S | |
| REG-354 | Configurable background image / branding | `customer_display_bg_img` | P2 | S | |
| REG-355 | Mirror payment QR codes and scale weighing on the display | QR overlay, scale data | P2 | M | |
| REG-356 | Pair a display by QR/URL from the register navbar | navbar customer-display opener | P2 | S | |

## 1.15 Multi-device synchronisation (REG-365 … REG-384)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| REG-365 | Realtime channel per register (and per session) | `pos.bus.mixin._notify`, channel = access token | P0 | M | Channel name is a secret token, not an id. |
| REG-366 | Fan-out of changed records to sibling devices after every sync | `notify_synchronisation(session, device_identifier, records)` | P0 | M | The originating **device identifier** is included so the sender ignores its own echo. Without it you get sync storms. |
| REG-367 | Delta pull of open orders and related records | `read_config_open_orders(domain, ids)` → `dynamic_records` | P0 | L | Returns both changed records **and** `deleted_record_ids`. Clients must handle deletions; a pull-only-changes design leaks ghost orders forever. |
| REG-368 | Local purge of records the server says are irrelevant | `filter_local_data` | P1 | M | Covers archived/inactive records too, not just deletions. |
| REG-369 | Incremental data load using a server-clock watermark | `pos_last_server_date`, `_data_server_date` | P0 | L | The watermark is the **server's** clock captured at load, never the client's. Session/config/user records are always fully reloaded. Pricelist items need special handling: an item whose `date_start` just became active has an old `write_date` and would be missed. |
| REG-370 | Full-reload trigger when the register configuration changed | `pos.config.last_data_change` vs cached value | P1 | M | |
| REG-371 | Per-device order numbering namespaces | `register_new_device_identifier`, `DeviceIdentifierSequence` | P0 | M | Device id is allocated once from the server and cached in localStorage; the sequence is local. Recycles unused numbers when an order is abandoned. |
| REG-372 | Trusted registers: share open orders across registers (e.g. bar + terrace) | `trusted_config_ids`, `isShareable` | P2 | M | Currency must match. Shared orders appear in the order list and can be paid from either register. |
| REG-373 | Conflict resolution: server-wins re-read on non-connection sync errors | `deviceSync.readDataFromServer()` | P0 | M | On a hard error the client discards its local view of the order and re-reads. On a connection error it keeps the order pending. Distinguishing the two correctly is essential. |
| REG-374 | Multi-tab guard: opening the register in a second tab closes the older one | localStorage broadcast | P1 | S | Two tabs on one device share IndexedDB and will corrupt the pending queue. |
| REG-375 | Sync status indicator + pending-operations popup | `SyncPopup` | P1 | M | Must list *what* is pending in human terms ("2 orders, 1 cash movement"), not a spinner. |
| REG-376 | Force data reload / reset local cache | `reloadData(fullReload)` | P1 | S | The support escape hatch. Must refuse while unsynced paid orders exist. |

---

# 2. RST — Restaurant

## 2.1 Floors & floor plan (RST-001 … RST-029)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-001 | Floor entity (name, sequence, colour, background image, register links, active flag) | `restaurant.floor` | P0 | M | A floor can be shared by several registers. Archiving is soft-delete. |
| RST-002 | Floor screen as the default landing page | `FloorScreen`, `pos.config.default_screen` | P0 | M | `default_screen` = `tables` or `register`. |
| RST-003 | Floor tab bar with an unsent-changes badge per floor | `getFloorChangeCount` | P1 | M | Badge counts *unsent kitchen changes* summed over the floor's tables. |
| RST-004 | Positioned map rendering of tables | floor screen `default` style | P0 | L | Tables are absolutely positioned in px; the canvas auto-sizes from table extents or the background image. |
| RST-005 | Grid/kanban rendering fallback (default on small screens) | floor screen `kanban` style | P1 | M | Toggle persisted in localStorage. |
| RST-006 | Floor background colour (named palette with light/dark variants) or uploaded image | `background_color`, `floor_background_image` | P1 | M | The client stores a palette *key*, not a raw colour, so dark mode works. |
| RST-007 | Pinch-to-zoom and per-floor scroll position memory | CSS `--scale`, scroll memory | P2 | M | |
| RST-008 | Table rendering: number, shape (square/round), size, colour, occupied state | `restaurant.table` fields | P0 | M | Default table colour is green `#35d374`; occupied tables get a distinct style. |
| RST-009 | Per-table unsent-changes badge | `getChangeCount` → `getOrderChanges().nbrOfChanges` | P1 | S | Note: Odoo 19 removed the older "amount / minutes since order" badges. We should **add them back** as a P2 improvement (RST-016). |
| RST-010 | "New Order" (direct sale, no table) button | direct-sale flow | P0 | S | Direct-sale orders are named "Direct Sale" until named. |
| RST-011 | Jump to a table by typing its number | `NumpadDropdown`, `findTable` | P1 | S | |
| RST-012 | Table search by number in the order list | ticket screen `table_id.table_number` | P2 | S | |
| RST-013 | Guest count per table = sum over its open orders | `getCustomerCount(tableId)` | P1 | S | |
| RST-014 | Idle return to the floor plan after 3 minutes | floor screen idle redirect | P2 | S | Suppressed on payment/ticket/login screens. |
| RST-015 | Default floor + table auto-created when a register becomes a restaurant | `_setup_default_floor` | P2 | S | |
| RST-016 | Table info badges: open amount and minutes since the last order/fire | *(present in Odoo ≤16, removed in 19)* | P2 | M | Restores the at-a-glance "which table has been waiting" signal that the change-count badge alone does not give. Timer source must be the last *kitchen fire*, not order creation. |

## 2.2 Floor editor (RST-030 … RST-049)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-030 | Edit mode toggle (per device, Escape exits) | `pos.isEditMode` | P0 | S | Edits write straight through to the server — there is no local draft of the layout. |
| RST-031 | Create / rename / duplicate a floor | floor editor actions | P1 | M | Duplicating copies all tables. |
| RST-032 | Deactivate a floor (guarded by draft orders) | `deactivate_floor(session_id)` | P1 | M | Refuses while draft orders exist on its tables; also deactivates all its tables and purges local open orders on that floor. |
| RST-033 | Add a table with smart placement | add-table algorithm | P1 | M | Scans existing rectangles for the first free slot, grid-snaps, auto-numbers `max+1`, and scrolls to it. |
| RST-034 | Drag to move with 10-px grid snapping | drag & drop | P0 | M | Snapping is **disabled** when the floor has a background image (you align to the picture instead). |
| RST-035 | Resize via 4 corner handles, min 30 px, constrained to the floor | resize handles | P1 | M | |
| RST-036 | Multi-select tables (ctrl/meta click) and bulk-edit | multi-select | P1 | M | |
| RST-037 | Change seats / shape / colour / number | table property editors | P0 | S | |
| RST-038 | Duplicate a table (offset +10/+10) | duplicate action | P2 | S | |
| RST-039 | Soft-delete a table, guarded by draft orders | `are_orders_still_in_draft` | P1 | S | |
| RST-040 | Block floor/table structural changes while a session is open | `_unlink_except_active_pos_session`, `_get_forbidden_change_fields` | P1 | S | Odoo forbids changing a register's floor list mid-session. Cosmetic edits are allowed. |

## 2.3 Tables: linking, transfer, merge (RST-050 … RST-069)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-050 | Table linking: drag table A onto table B for >400 ms to physically merge them | `parent_id`, `set_parent_id` | P1 | XL | Child snaps to the nearest side of the parent; children render semi-transparent; clicking a child opens the parent's order; the order name becomes `T 3 & 4`. Cycle-guarded server-side. |
| RST-051 | Linking merges the child's open order into the parent's order | `mergeTableOrders` | P1 | L | |
| RST-052 | Unlinking restores the pre-merge lines and courses onto a new order on the child table | `uiState.unmerge` / `unmergeCourses` bookkeeping | P1 | XL | Per-line `{table_id, quantity, formerUuid}` and per-course `{table_id, lines, index, fired, fired_date}` snapshots. This is the subtlest single feature in `pos_restaurant`; without it a mis-drag destroys a table's order. |
| RST-053 | Child links are cleared automatically after the parent's order is paid | `afterOrderValidation` | P1 | S | |
| RST-054 | Transfer an order to another table | `startTransferOrder` | P0 | M | Transfer mode shows a sticky warning banner and navigates to the floor plan; self-transfer is rejected. |
| RST-055 | Merge an order into another table's existing order | `_mergeOrders` | P0 | L | Merging sums guest counts, merges mergeable lines (same course!), re-parents courses by matching `index`, combines print history, records unmerge info, and **deletes the source order**. |
| RST-056 | Migrate kitchen-sent quantities during transfer/merge so no spurious tickets are produced | `handlePreparationHistory` | P0 | L | The `last_order_preparation_change` snapshot must move with the lines. Skipping this reprints the whole order to the kitchen. |
| RST-057 | Merge a floating order into another order from the order list | ticket-screen transfer target | P1 | M | |
| RST-058 | One draft order per table, enforced server-side and client-side | `_get_open_order` override (uuid OR table+draft+config) | P0 | M | When two waiters race, the device-sync layer moves the loser's lines onto the **oldest synced order** and deletes the duplicate. |
| RST-059 | Book / unbook a table (keep an empty order open) | order summary book/unbook | P2 | S | |

## 2.4 Guest count (RST-070 … RST-079)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-070 | Guest count on the order, defaulting to the table's seats | `pos.order.customer_count`, `table.seats` | P0 | S | Minimum 1. |
| RST-071 | Guest count editor with live "amount per guest" feedback | Guests control button | P0 | S | Setting 0 guests on an empty order deletes the order. |
| RST-072 | Presets can force the guest prompt | `pos.preset.use_guest`, `ensureGuestCustomerCount` | P1 | S | Prompt fires the first time the order is sent. |
| RST-073 | Guest count on receipts, kitchen tickets and the payment screen | receipt header, prep ticket header | P1 | S | Receipt prints "Table N, Guests: C"; the payment screen shows an amount-per-guest hint when >1. |
| RST-074 | Splitting a bill decrements the original order's guest count | split flow | P2 | S | |

## 2.5 Courses (RST-080 … RST-099)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-080 | Course entity per order (index, fired flag, fired timestamp, lines) | `restaurant.order.course` | P0 | M | UUID-keyed like orders — courses are created offline. |
| RST-081 | Create a course; the first course absorbs all existing lines and opens an empty course 2 | `pos.addCourse()` | P0 | M | This implicit "course 1 = everything so far" behavior surprises people who read the code but is correct UX. |
| RST-082 | New lines attach to the selected (or last) course; combo children follow their parent | line-to-course assignment | P0 | S | |
| RST-083 | Order display groups lines under clickable course headers with a "Fired" tag | `OrderCourse` component | P0 | M | |
| RST-084 | Fire a course: mark fired, send to preparation, print a dedicated "Course N fired" ticket | `fireCourse`, `printCourseTicket` | P0 | L | The fire ticket is a *note-update*-type change listing the course's products — not a NEW ticket, so quantities are not re-counted. |
| RST-085 | Sending the order normally implicitly fires the first course | `submitOrder` | P1 | S | |
| RST-086 | Transfer a line (with combo children) or a whole course to another course | Transfer-course button | P1 | M | |
| RST-087 | Clean up trailing empty unfired courses and re-index 1..n | `cleanCourses()` | P1 | S | Runs when leaving the product screen. Re-indexing must not renumber fired courses in a way that confuses the kitchen. |
| RST-088 | Kitchen tickets and bills group lines by course | `receiptLineGrouper` | P0 | M | |
| RST-089 | Course state survives split / merge / unmerge (matched by index) | split & merge handlers | P1 | L | |
| RST-090 | "Fire Course N" primary action on the action pad when the selected course is ready | actionpad patch | P1 | S | |

## 2.6 Bill splitting & proforma (RST-100 … RST-119)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-100 | Split-bill screen: tap lines to move quantities into the new bill | `SplitBillScreen`, `uiState.splitQty` | P0 | L | Tapping cycles 0→1→…→max→0. Combos move as a whole. A running total of the new bill is shown, and each line shows `x / y`. |
| RST-101 | Create the split order (letter-suffixed name `…B`, `…C`, max 26 parts) | `createSplittedOrder` | P0 | L | Copies preset, preset time, fiscal position, pricelist; recreates the selected quantities as new lines; re-links combos; re-creates courses by index; re-applies the original global discount. |
| RST-102 | Migrate kitchen-sent quantities to the split order | `handlePreparationHistory` | P0 | M | Same rule as RST-056. |
| RST-103 | Decrement the original order's guest count on split | split flow | P2 | S | |
| RST-104 | "Continue splitting" loop after the split bill is paid | `isContinueSplitting`, `uiState.splittedOrderUuid` | P1 | M | The receipt/feedback screen offers to return to the original order and split again. |
| RST-105 | Split-and-transfer variant (split off lines, then move them to another table) | `transferSplittedOrder` | P2 | M | |
| RST-106 | Double-execution guard on split | `uiState.isSplitInProgress` | P1 | S | A double-tap here duplicates revenue. |
| RST-107 | Split by amount / equal split among N guests | *(not in Odoo)* | P2 | L | Not a parity item — a common competitive requirement. Implement as "even split creates N payment lines", not N orders. |
| RST-110 | Proforma bill printing before payment | `iface_printbill`, `printReceipt({printBillActionTriggered:true})` | P0 | M | Prints the standard receipt **without** incrementing `nb_print`, with a "Pro forma receipt" banner while the order is not finalized. |
| RST-111 | Gratuity suggestion block on the proforma bill | `set_tip_after_payment` receipt footer | P2 | S | 15/20/25 % of the tax-inclusive total. |

## 2.7 Tips (RST-120 … RST-139)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-120 | Tip product configuration | `iface_tipproduct`, `tip_product_id` | P0 | S | |
| RST-121 | Tip added during payment | `pos.setTip` (see REG-220) | P0 | S | |
| RST-122 | Tip-after-payment mode: route to a tip screen instead of the receipt | `set_tip_after_payment`, `TipScreen` | P1 | L | Only when the first payment line `canBeAdjusted()` — i.e. terminal-supported, or any non-cash non-QR method. Payment buttons relabel to "Close Tab" / "Keep Open". |
| RST-123 | Tip screen: quick 15/20/25 % buttons, custom amount, >25 % confirmation | `TipScreen` | P1 | M | |
| RST-124 | Signature tip slip printed on entering the tip screen | `TipReceipt` | P1 | M | Terminal ticket + subtotal + blank tip/total lines + signature line. |
| RST-125 | Apply the tip: add the tip line to an already-paid order and adjust the payment | `validateTip`, `sendPaymentAdjust`, `_update_payment_line_for_tip` | P1 | L | Odoo temporarily flips the order state draft→paid to add the line. Our model should allow a controlled "tip adjustment" mutation on a paid order instead of state gymnastics — but the resulting totals must match. |
| RST-126 | "No tip" path recording an explicit zero tip | `is_tipped = true, tip_amount = 0` | P1 | S | Distinguishing "no tip given" from "not yet asked" matters for the tipping report. |
| RST-127 | Bulk tip settlement from the order list (TIPPING state + inline tip cells) | `TipCell`, `settleTips()` | P1 | L | Managers settle a whole shift of tips at once. |
| RST-128 | Terminal tip adjustment driver interface | `PaymentInterface.canBeAdjusted/sendPaymentAdjust` | P2 | M | |
| RST-129 | Tip reporting per cashier/shift | *(derived)* | P2 | M | Not in Odoo as a report; needed operationally. |

## 2.8 Restaurant order lifecycle extras (RST-140 … RST-159)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| RST-140 | Table orders named `T <n>` / `T <n> & <m>`; table-less orders named "Direct Sale" | `getName` patch | P1 | S | |
| RST-141 | Presets without a table force an order name (partner name or prompt) | naming rules | P2 | S | |
| RST-142 | Orders with a table or courses are always persisted server-side immediately | `shouldCreatePendingOrder` | P0 | S | Unlike retail, a restaurant order must exist on the server as soon as it has a table — other devices need to see it. |
| RST-143 | "Order has unsent changes" prompt when paying | `_askForPreparation` | P0 | M | Also hooked into fast payment (REG-209). |
| RST-144 | Unsent-change chips per category on the order button | `getCategoryCount` | P1 | M | e.g. "2 Drinks, 1 Food". |
| RST-145 | Lines with unsent changes get a distinct visual state | `has-change` class | P1 | S | |
| RST-146 | Floating-order tabs show an unsent-change bubble | order tabs patch | P2 | S | |

---

# 3. KDS — Kitchen

> **Positioning.** Odoo's graphical Kitchen Display (`pos.prep.*`, `pos_enterprise`) is **enterprise-only**;
> community ships printer-only kitchen routing. We build the KDS as a first-class part of the product, and we
> keep the printer path as an equal-status alternative (many kitchens still want paper).
> KDS-001…049 are the display; KDS-050…089 are the printing/routing engine shared with §2.

## 3.1 Preparation display (KDS-001 … KDS-049)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| KDS-001 | KDS web app (own route, own PWA scope, tablet-first, touch targets ≥ 64 px) | *(new; enterprise `pos_enterprise`)* | P0 | L | Must run full-screen on cheap Android tablets and survive a browser restart without losing state. |
| KDS-002 | Device pairing/auth for a display (token URL, no cashier login) | analogous to `pos.config.access_token` | P0 | M | Displays are shared devices: no personal login, a revocable device token, and no access to money data. |
| KDS-003 | Preparation station entity (name, category routing, register links, display or printer) | generalization of `pos.printer` | P0 | M | One entity models both "print to this printer" and "show on this screen" so routing is configured once. |
| KDS-004 | Category-based routing of items to stations | `pos.printer.product_categories_ids` | P0 | M | Combo children route by the **parent's** category when the child has none — reproduce `filterChangeByCategories`. |
| KDS-005 | Order cards showing table/tracking, service mode, guest count, elapsed time, items | enterprise KDS | P0 | L | Card content is driven by the change payload, not by the whole order — a card shows what *this station* must make. |
| KDS-006 | Item rows with quantity, attributes, notes (customer + internal), combo grouping | prep ticket content | P0 | M | Notes must be visually loud; they are the #1 source of kitchen errors. |
| KDS-007 | Course grouping and course headers on cards | `restaurant.order.course` | P0 | M | |
| KDS-008 | Stage model: `todo → in progress → ready → served/done` with per-station stages | enterprise `pos.prep.state` | P0 | L | Stages are **per station per item**, aggregated to a card status. Design the state machine explicitly; ad-hoc booleans will not survive multi-station orders. |
| KDS-009 | Bump a card (mark done) and un-bump/recall | enterprise KDS | P0 | M | Recall must be time-limited or manager-gated, otherwise it hides mistakes. |
| KDS-010 | Per-item done toggle | enterprise KDS | P1 | M | |
| KDS-011 | Colour-coded age timers with configurable warning/critical thresholds | enterprise KDS | P0 | M | Timer starts at *fire* time (course), not at order creation. |
| KDS-012 | Filters: station, category, course, service mode, "late only" | enterprise KDS | P1 | M | |
| KDS-013 | Layout modes: column-per-order card wall, and a consolidated item list ("make 12 fries") | enterprise KDS | P1 | L | The consolidated view is what high-volume kitchens actually use. |
| KDS-014 | New-order alert (sound + visual) with mute | enterprise KDS | P1 | S | |
| KDS-015 | Realtime updates pushed from register and self-order | bus channels | P0 | M | Sub-second latency target; falls back to polling. |
| KDS-016 | Cancellation display: cancelled items appear struck-through with an alert | delta engine `cancelled` | P0 | M | A cancelled item that was already cooked must be visible, not silently removed. |
| KDS-017 | Note-update display (note changed on an already-sent item) | delta engine `noteUpdate` | P1 | M | |
| KDS-018 | "Fire course" arrival on the KDS | `fireCourse` | P0 | M | |
| KDS-019 | Order-ready notification back to the register / order-status screen | *(new)* | P1 | M | Powers SLF-090 customer status tracking. |
| KDS-020 | Offline resilience: cached card state, queued state changes, reconnect reconciliation | *(new)* | P1 | L | A KDS that blanks when wifi hiccups is worse than paper. |
| KDS-021 | History / recall of recently bumped orders | enterprise KDS | P1 | M | |
| KDS-022 | Station load metrics (open cards, average prep time, late count) | *(new)* | P2 | M | |
| KDS-023 | Multi-display mirroring and expeditor ("pass") view showing all stations for an order | enterprise KDS | P2 | L | |
| KDS-024 | Auto-print fallback when a display is unreachable | *(new)* | P2 | M | |

## 3.2 Preparation printing & the change-delta engine (KDS-050 … KDS-089)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| KDS-050 | Preparation printer entity (name, type iot/ePOS, IP, category routing, register links) | `pos.printer` | P0 | M | |
| KDS-051 | Change-delta engine: diff current lines against the last-sent snapshot | `order_change.js :: getOrderChanges` | P0 | XL | The diff key is `uuid + note` (a note change makes it a *different* item). Output: quantity additions (+n), removals (−n) including fully deleted lines, note-only updates, and order-level note diffs, plus `nbrOfChanges` (absolute) and `count` (signed). Every downstream feature (badges, prompts, tickets, KDS) reads this. Port it with a dedicated fixture suite. |
| KDS-052 | `last_order_preparation_change` snapshot persisted on the order | `pos.order.last_order_preparation_change` (JSON) | P0 | M | Contains a `metadata.serverDate` used for cross-device conflict detection. |
| KDS-053 | Ticket splitting into NEW / CANCELLED / NOTE-UPDATE / order-note tickets | `generateReceiptsDataToPrint` | P0 | L | Up to 4 tickets per printer per send. |
| KDS-054 | Per-printer filtering of changes by category | `filterChangeByCategories` | P0 | M | |
| KDS-055 | Ticket layout: station name, table/floor, guest count, tracking number, service mode, course sections, notes | `OrderChangeReceipt` (+restaurant extension) | P0 | M | |
| KDS-056 | Send-to-kitchen action with offline tolerance | `submitOrder` → `sendOrderInPreparation` | P0 | L | Printing is attempted **even when offline**; the snapshot is updated locally and synced later. |
| KDS-057 | Cross-device conflict guard before sending | `get_preparation_change`, `metadata.serverDate` compare | P0 | L | If the server snapshot is newer, warn "Order Outdated", adopt the server state, and do **not** print. This is what stops two waiters double-firing a table. |
| KDS-058 | Snapshot update + immediate order sync after printing | `updateLastOrderChange()` then sync | P0 | M | Odoo skips the forced sync when a KDS is present (the KDS is the source of truth then). |
| KDS-059 | Reprint the last kitchen ticket even when there are no changes | `explicitReprint`, `uiState.lastPrints` | P1 | M | |
| KDS-060 | Retry dialog for failed prep printers | `RetryPrintPopup` | P1 | M | Per-printer error detail; retrying must not double-print already-successful printers. |
| KDS-061 | Success toast summarizing what was sent, per category | `getCategoryCount` | P2 | S | |
| KDS-062 | Server-side snapshot rebuild ("everything already sent") | `pos.session._set_last_order_preparation_change` | P1 | M | Used by self-order so customer-submitted lines are not re-sent by the cashier. |
| KDS-063 | Printer test action from the back office | `backend/test_epos` | P2 | S | |
| KDS-064 | Local Network Access (Chrome private-network) permission handling for LAN printers | `init_lna.js`, `use_local_network_access()` | P1 | M | Without the permission prompt handled, LAN printing silently fails on new Chrome versions. |

---

# 4. SLF — Self-order (QR menu, table ordering, kiosk)

## 4.1 Modes, entry & tokens (SLF-001 … SLF-019)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| SLF-001 | Mode selector per register: disabled / QR menu (consultation) / QR menu + ordering (mobile) / kiosk | `pos.config.self_ordering_mode` | P0 | M | Mode drives everything downstream; changing it mid-session must be blocked or handled. |
| SLF-002 | Consultation mode: browse-only menu, works with no open session | `_verify_entry_access` returns empty token | P1 | M | The client boots with **no** access token, which is what disables ordering. Do not implement "ordering disabled" as a UI flag only — the API must reject. |
| SLF-003 | Mobile mode: order from a phone at a table or at a counter | `self_ordering_service_mode` counter/table | P0 | L | |
| SLF-004 | Kiosk mode: full-screen self-service terminal | kiosk client behaviors | P1 | XL | |
| SLF-005 | Pay-after policy: `meal` (accumulate, pay at end) vs `each` (pay per submission) | `self_ordering_pay_after` | P0 | M | Odoo's forced combinations: kiosk ⇒ each; mobile+counter ⇒ each; mobile without restaurant ⇒ each; mobile+meal ⇒ forces table service. Encode these as validation rules, not as UI hints. |
| SLF-006 | Register access token in the URL, doubling as the realtime channel name | `pos.config.access_token` | P0 | S | |
| SLF-007 | Per-table identifier token embedded in the table QR | `restaurant.table.identifier` | P0 | S | Separate from the table id so QRs can be rotated without renumbering tables. Child (linked) tables resolve to the parent at entry. |
| SLF-008 | Per-order access token giving the customer capability to view/cancel/pay their order | `pos.order.access_token` | P0 | S | Constant-time comparison everywhere. |
| SLF-009 | Token rotation invalidating all printed QRs | `update_access_tokens()` | P2 | S | Must warn loudly — it invalidates every printed table card. |
| SLF-010 | Anonymous request execution as a designated service user | `self_ordering_default_user_id`, `sudo(False).with_user(...)` | P0 | M | All public self-order requests run with one configured identity and the register's company. Our equivalent: a service principal with a narrow ability set. Never run them as an admin. |
| SLF-011 | QR code generation per table / per floor / generic | `_get_qr_code_data` | P1 | M | |
| SLF-012 | Printable QR sheet (PDF, 3 per row) and bulk export (ZIP + spreadsheet of URLs) | `generate_qr_codes_page`, `generate_qr_codes_zip` | P2 | M | |
| SLF-013 | Short links for QR URLs | `link.tracker` | P2 | S | Long URLs make dense QRs that scan badly on printed cards — worth doing. |
| SLF-014 | Per-register PWA manifest (app name = register name, icon = company logo) | `controllers/webmanifest.py` | P2 | S | |
| SLF-015 | "We're currently closed" state when no session is open | `_verify_config_constraint` | P1 | S | The menu still renders; only ordering is disabled. |

## 4.2 Customer menu & ordering flow (SLF-020 … SLF-059)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| SLF-020 | Landing page: image carousel, branding, language selector, custom links | `landing_page`, `pos_self_order.custom_link` | P1 | M | Custom links are configurable buttons (label, URL, Bootstrap style, sequence, per-register). |
| SLF-021 | Service-mode (preset) selection page | `eating_location_page` | P1 | M | On mobile without a scanned table, `service_at = table` presets are hidden. |
| SLF-022 | Category rail with scroll-spy on mobile and a sliding sub-category panel on kiosk | `product_list_page` | P0 | L | |
| SLF-023 | Category time-window availability | `hour_after` / `hour_until` | P1 | S | |
| SLF-024 | Product cards with public images, rich HTML description, price incl./excl. tax | `public_description`, `_can_return_content` | P0 | M | Menu images must be publicly downloadable **without auth** — a deliberate policy decision, not an accident. |
| SLF-025 | Per-product self-order availability flag | `product.template.self_order_available` | P0 | S | Forced false when the product is not available in the register at all. |
| SLF-026 | Live menu availability push (86'ing an item updates all open menus instantly) | bus `PRODUCT_CHANGED` | P1 | M | High-value feature; the payload is the freshly serialized product, not just an id. |
| SLF-027 | Product detail page: quantity stepper, customer note, attribute selection with price extras | `product_page`, `attribute_selection` | P0 | L | Custom free-text attribute values are hidden on kiosk for no-variant attributes. |
| SLF-028 | Variant resolution for always/dynamic-variant attributes | `getProductVariantByAttributes` | P1 | M | The resolved variant's own price and taxes are used, not the template's. |
| SLF-029 | Missing-required-attribute UX | `missing_required_details` | P1 | S | |
| SLF-030 | Combo stepper: choice-by-choice selection with free/extra pricing and inline attributes | `combo_page`, `combo_stepper` | P0 | XL | Only choices needing interaction are shown as steps. Total price uses the same combo split as the register (REG-075). |
| SLF-031 | Cart page: line list, quantity edit, note edit, remove, running total | `cart_page` | P0 | M | In pay-after-meal mode only **unsent** lines are shown as new. |
| SLF-032 | Upsell / optional products in the cart | `pos_optional_product_ids` | P2 | M | |
| SLF-033 | Cart validation: drop items that became unavailable, with an explaining dialog | `verifyCart`, `UnavailableProductsDialog` | P1 | M | |
| SLF-034 | Required customer info collection (name, email, phone, address, time slot) driven by the preset | `PresetInfoPopup`, `/validate-partner` | P1 | L | Requirements come from preset `identification`, `use_timing`, and whether a confirmation mail template exists. |
| SLF-035 | Manual table picker when no table was scanned | `PopupTable` | P1 | M | |
| SLF-036 | Submit order: create or append by UUID | `/process-order/<device_type>`, `_get_open_order` | P0 | L | Same UUID ⇒ update the existing draft (append lines). Unknown UUID ⇒ create. In `each` mode the client clears its order UUID after submit so the next basket is a new order. |
| SLF-037 | Server-side sanitation of the submitted payload (field whitelists, forced state, recomputed reference) | `_check_pos_order`, `_check_pos_order_lines` | P0 | L | Client-submitted prices are **never** trusted. |
| SLF-038 | Server-side price recomputation (pricelist, attribute extras, combo split, fiscal position) | `recompute_prices`, `_compute_combo_price` | P0 | L | Odoo ports the JS combo algorithm to Python for exactly this. In our stack the server implementation is the same PHP code the register's totals are validated against (REG-174). |
| SLF-039 | Shared table order: several phones at one table append to the same draft order | `get-user-data` returning other drafts on the table | P1 | L | The client merges foreign draft-order lines into its view. Conflict-prone; needs careful UX ("Ali added 2 Cokes"). |
| SLF-040 | Local change tracking so only new lines are submitted | `uiState.lineChanges`, `changes` getter | P0 | M | |
| SLF-041 | Cancel an unpaid self-order | `/remove-order` with order token | P1 | S | |
| SLF-042 | Zero-amount orders are auto-paid and receipted | `process-order` zero-amount path | P2 | S | |
| SLF-043 | Order naming/tracking prefixes per source (`K…` kiosk, `S…` mobile) and floating names | naming rules | P1 | S | Lets staff tell at a glance where an order came from. |
| SLF-044 | Barcode scanning in the self app | self-order barcode support | P2 | S | |

## 4.3 Self-order payment (SLF-060 … SLF-079)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| SLF-060 | "Pay at counter/cashier" flow (no payment methods configured) | default mobile behavior | P0 | M | The order is simply sent; the cashier settles it in the register. This is the most common configuration and must be flawless. |
| SLF-061 | Online payment from the customer's phone | `pos_online_payment` + glue module | P1 | XL | Payment lines are created **only** from a confirmed provider transaction, server-side. |
| SLF-062 | Kiosk QR to a hosted payment page | glue `getOnlinePaymentUrl` + QR | P2 | M | |
| SLF-063 | Kiosk payment terminal integration | `/kiosk/payment/...`, `_payment_request_from_kiosk` | P2 | L | Async result arrives over the realtime channel (`PAYMENT_STATUS`). |
| SLF-064 | Payment-method visibility rules for the self client | `_load_pos_self_data_domain` on payment methods | P1 | S | Kiosk sees terminal + online methods; mobile sees only the designated online method. Cash is forbidden on kiosk. |
| SLF-065 | Payment status notifications to the self app (progress / success / fail) | bus `ONLINE_PAYMENT_STATUS`, `PAYMENT_STATUS` | P1 | M | |
| SLF-066 | Exactly-once receipt/kitchen printing on the cashier side after online payment | `get_order_to_print` (`FOR UPDATE NOWAIT` + `nb_print`) | P1 | M | Two cashier devices listening to the same event will both try to print. The row lock is the fix. |
| SLF-067 | Unpaid-amount and next-payment-amount tracking for partial online payments | `get_amount_unpaid`, `next_online_payment_amount` | P2 | M | |

## 4.4 Confirmation, status tracking & kiosk specifics (SLF-080 … SLF-109)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| SLF-080 | Confirmation page with tracking number and receipt | `confirmation_page` | P0 | M | Addressed by the order access token, so it can be re-opened later or shared. |
| SLF-081 | Order history page (locally known orders, persisted) | `order_history_page`, IndexedDB | P1 | M | Draft orders can be re-opened into the cart. |
| SLF-082 | Live order status updates | bus `ORDER_STATE_CHANGED` → delta RPC `get-user-data` | P0 | L | Delta RPC is keyed on `(access_token, write_date, state)` of known orders. Server also pushes `REMOVE_ORDERS` with deleted tokens for local cascade-delete. |
| SLF-083 | Customer-facing preparation status ("received → preparing → ready") | *(new; needs KDS-019)* | P1 | L | Odoo does not have this; it is the main reason customers scan the QR twice. Build it on KDS stages. |
| SLF-084 | Receipt by email using a per-preset mail template | `_send_self_order_receipt`, preset `mail_template_id` | P1 | M | |
| SLF-085 | Receipt download as an image on mobile | confirmation page download | P2 | S | |
| SLF-090 | Kiosk idle timeout returning to the landing page | `TimeoutPopup` (90 s) | P1 | S | Also wipes the local basket — a kiosk must never show the previous customer's order. |
| SLF-091 | Kiosk receipt printing (ePOS / IoT) with an exactly-once guard | `increment_nb_print` | P1 | M | |
| SLF-092 | Kiosk prints its own kitchen tickets | `printKioskChanges` | P2 | M | |
| SLF-093 | Kiosk paper-status tracking and alerting | `has_paper`, `/change-printer-status` | P2 | S | |
| SLF-094 | Kiosk language reset after each order | kiosk language handling | P2 | S | |
| SLF-095 | Kiosk table-tracker / stand-number entry | `stand_number_page`, `table_stand_number` | P2 | M | |
| SLF-096 | Kiosk open/closed status push (session opened/closed) | bus `STATUS` | P1 | S | |
| SLF-097 | Closing a kiosk register deletes remaining draft orders | `close_ui()` override | P1 | S | |
| SLF-098 | Kiosk branding: background images, brand image/name, injected primary colours | `self_ordering_image_*`, `kiosk_style.js` | P2 | M | |

## 4.5 Self-order ↔ register integration (SLF-110 … SLF-129)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| SLF-110 | Self-orders appear as ordinary draft orders in the register's order list | `source` = mobile/kiosk, normal order sync | P0 | M | |
| SLF-111 | Self-orders appear on the scanned table even before a cashier assigns one | `self_ordering_table_id` + `RestaurantTable.getOrders()` | P0 | M | Two different table fields (`table_id` vs `self_ordering_table_id`) exist so the customer's scan is not overwritten by staff moves; keep both and keep them in sync on transfer. |
| SLF-112 | Kiosk draft orders included in the register's server-order domain | `getServerOrdersDomain` override | P1 | S | |
| SLF-113 | Order-source badges and status labels in the register order list | ticket screen patches | P1 | S | |
| SLF-114 | New-self-order alert on the register (sound/toast) | *(new)* | P1 | S | Odoo relies on the bus refresh only; staff miss orders. |
| SLF-115 | Self-order submissions do not re-print items the customer already sent | `_set_last_order_preparation_change` | P0 | M | |

---

# 5. BOF — Back-office

Inertia + React admin. Everything here is online-only.

## 5.1 Dashboard & registers (BOF-001 … BOF-029)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-001 | Register dashboard: one card per register with live session state | `view_pos_config_kanban` | P0 | L | Card badges: "Opened by X", "Opening control", "Closing control", "To close" with warning/danger colouring at >1 day / >3 days open. |
| BOF-002 | Live session statistics on the card (opening cash, sold count/amount, ongoing count/amount) | `statistics_for_current_session` | P1 | M | "Sold" is net of fully-refunded orders. |
| BOF-003 | Open register / continue selling / close actions from the dashboard | `open_ui`, `open_existing_session_cb` | P0 | S | |
| BOF-004 | Last-closing summary when no session is open | `last_session_closing_cash/date` | P2 | S | |
| BOF-005 | Rescue-session surfacing and resolution | `number_of_rescue_session` | P1 | M | |
| BOF-006 | Register CRUD (create/duplicate/archive) | `pos.config` | P0 | M | Archiving is blocked while a session is open. |
| BOF-007 | Quick "new shop" creation wizard | config form modal | P2 | M | |
| BOF-008 | Per-register contextual links (orders, sessions, reporting, settings) | kanban menu | P2 | S | |

## 5.2 Register settings — all groups (BOF-030 … BOF-079)

> Odoo's settings screen is one page of `pos_*` proxy fields writing to the selected register.
> We model it as tabbed settings on the register record. Each row below is one settings group.

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-030 | Settings shell: register selector, session-open locking of unsafe fields, validation feedback | `res.config.settings` POS page | P0 | L | Odoo hard-blocks changing payment methods, restaurant mode, floors, and active flag while a session is open (`_get_forbidden_change_fields`). Reproduce the lock list exactly — these are the changes that corrupt open sessions. |
| BOF-031 | Group: general (name, company, currency, restaurant mode) | `pos.config` | P0 | S | |
| BOF-032 | Group: service modes / presets (enable, available, default) | `use_presets`, `available_preset_ids`, `default_preset_id` | P1 | S | The default preset is auto-added to the available list. |
| BOF-033 | Group: payment (methods, terminal auto-validate, fast payment, cash rounding, max closing difference, tips) | payment settings block | P0 | M | |
| BOF-034 | Group: interface (employee login, large scrollbars, product/category images, group-by-category, shared registers) | interface block | P1 | S | |
| BOF-035 | Group: catalogue restriction (limit categories, margins visibility) | catalogue block | P1 | S | |
| BOF-036 | Group: taxes & fiscal (tax display incl/excl, fiscal positions, default fiscal position, flexible taxes) | accounting block subset | P0 | M | |
| BOF-037 | Group: pricing (pricelists enabled/available/default, price control, manual discount, global discount) | pricing block | P0 | M | Currency consistency between pricelists and the register is validated. |
| BOF-038 | Group: receipts (header/footer, auto-print, skip preview, basic receipt, ticket QR/URL mode, unique ticket code) | bills & receipts block | P0 | M | |
| BOF-039 | Group: preparation (order printers, predefined notes, KDS stations) | preparation block | P0 | M | Note models are locked while a session is open. |
| BOF-040 | Group: connected devices (ePOS printer IP + test, IoT box proxy IP, scanner, scale, receipt printer, cash drawer, customer display background) | connected devices block | P1 | M | |
| BOF-041 | Group: restaurant (floors, bill splitting, early bill printing, tip after payment, default screen) | `pos_restaurant` settings | P0 | S | |
| BOF-042 | Group: self-order (mode, service mode, pay-after, languages, branding, images, custom links, default service user, online payment method) | `pos_self_order` settings | P1 | M | |
| BOF-043 | Group: inventory / fulfilment (ship later, stock update timing, barcode nomenclature + fallback) | inventory block | P2 | M | |
| BOF-044 | Group: order audit (edit tracking) | `order_edit_tracking` | P1 | S | |
| BOF-045 | Group: sequences & numbering (reference format, per-device sequences) | config sequences | P1 | M | Not exposed in Odoo's UI but needed for support. |

## 5.3 Catalogue / menu management (BOF-080 … BOF-109)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-080 | Product list/grid filtered to POS-available products, with POS columns | `product_template_action_pos_product` | P0 | L | |
| BOF-081 | Product editor: name, image, price, taxes, cost, internal ref, barcode, description, public description | `product.template` + POS page | P0 | L | |
| BOF-082 | POS-specific product fields: available in POS, self-order available, to-weight, POS categories, colour, display sequence, optional products | POS notebook page | P0 | M | `pos_sequence` drives register ordering and is edited by drag-and-drop. |
| BOF-083 | Product archive/delete guards while a session is open | product guards | P1 | S | Odoo blocks archiving POS products (and the tip product) during an open session. |
| BOF-084 | POS category tree management (name, parent, sequence, image, colour, availability window) | `pos.category` | P0 | M | Distinct from the accounting/inventory category — do not merge the two concepts. |
| BOF-085 | Product attributes and values (display type, price extra, custom values, colour/image) | `product.attribute*` | P1 | L | |
| BOF-086 | Attribute exclusion rules | `product.template.attribute.exclusion` | P2 | M | |
| BOF-087 | Variant management | `product.product` | P1 | M | |
| BOF-088 | Combo/menu builder: combo choices, `qty_free`, `qty_max`, base price, per-item extra price | `product.combo`, `product.combo.item` | P0 | L | |
| BOF-089 | Product tags with POS description and customer visibility | `product.tag`, `pos_description` | P2 | S | |
| BOF-090 | Pricelist management: rules by product/variant/category/global, min quantity, date windows, compute modes | `product.pricelist(.item)` | P1 | L | |
| BOF-091 | Tax management: rates, price-included flag, groups, receipt labels | `account.tax`, `account.tax.group.pos_receipt_label` | P0 | L | Changing a tax while unposted orders use it must be blocked (Odoo does exactly this). |
| BOF-092 | Fiscal position management (tax maps) | `account.fiscal.position` | P1 | M | |
| BOF-093 | Bulk import/export of the menu (CSV/XLSX) | *(not in Odoo POS specifically)* | P1 | L | Onboarding requirement — every migration starts with a spreadsheet. |
| BOF-094 | Menu availability scheduling / 86-ing an item with one click | derived from `self_order_available` + `PRODUCT_CHANGED` | P1 | M | |

## 5.4 Operational configuration (BOF-110 … BOF-129)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-110 | Payment method management (name, image, sequence, type cash/bank/on-account, terminal/QR integration, per-register assignment, identify-customer flag) | `pos.payment.method` | P0 | L | Odoo forbids editing a method (except `sequence`) while an open session uses it; a cash method may belong to exactly one register. |
| BOF-111 | Coins/bills denominations per register | `pos.bill` | P2 | S | |
| BOF-112 | Predefined note models (name, colour, sequence) | `pos.note` | P1 | S | Names are unique. |
| BOF-113 | Preset / service-mode management (name, image, pricelist, fiscal position, identification, return mode, timing, calendar, slots) | `pos.preset` | P1 | L | Deleting a preset linked to a register is blocked. |
| BOF-114 | Preparation printer management with category routing and test print | `pos.printer` | P0 | M | |
| BOF-115 | KDS station management | *(new)* | P0 | M | |
| BOF-116 | Floor & table management from the back office (list/form + inline table editing) | `restaurant.floor/table` views | P1 | M | The in-register floor editor (RST-030) is the primary tool; the back-office view is for bulk work. |
| BOF-117 | Employee management: profiles, badge, PIN, per-register access level | `hr.employee` + `pos_hr` lists | P0 | L | PIN/badge stored hashed. |
| BOF-118 | Role & permission management (abilities per role) | Odoo groups | P0 | L | Odoo has 3 groups; we need finer abilities (refund, discount above X, void, open drawer, close session, edit price). |
| BOF-119 | Customer management (list, form, POS barcode, order history) | `res.partner` + POS extensions | P1 | M | Deleting a customer with orders is blocked; archive instead. |
| BOF-120 | Cashier badge label printing | `report_userlabel` | P2 | S | |

## 5.5 Orders, sessions & payments administration (BOF-130 … BOF-159)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-130 | Order list with filters (state, invoiced, date, register, session, cashier, customer) and grouping | `view_pos_order_tree` + search view | P0 | L | |
| BOF-131 | Order detail: lines, payments, totals, margins, customer, preset, table, guests, notes, references, edit flags | `view_pos_pos_form` | P0 | L | Read-only except for a narrow set of admin actions. |
| BOF-132 | Admin actions on an order: register a payment, invoice, refund, cancel, resend receipt | header buttons + wizards | P1 | L | Cancel refuses orders with a future preset time and notifies registers over the realtime channel. |
| BOF-133 | Session list and detail with cash figures and state | `view_pos_session_form` | P0 | M | |
| BOF-134 | Session drill-downs: orders, payments, cash movements, summary document | session stat buttons | P1 | M | |
| BOF-135 | Force-close a session with an explicit reason/adjustment | `pos.close.session.wizard` | P1 | M | Odoo's version balances a journal entry; ours records an explicit adjustment with a reason and an approver. |
| BOF-136 | Payments list (read-only) with method/session grouping and terminal metadata | `pos.payment` views | P1 | M | |
| BOF-137 | Order line explorer ("all sales lines") | `pos.order.line` views | P2 | S | |
| BOF-138 | Bulk email of receipts from the order list | `action_send_mail` | P2 | S | |
| BOF-139 | Edited-order audit view (which orders were edited, what changed, by whom) | `is_edited`, `has_deleted_line`, chatter | P1 | M | Odoo buries this in the chatter; a dedicated view is a real improvement and a common auditor request. |

## 5.6 Reporting (BOF-160 … BOF-189)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-160 | Sales details report (date range × registers): products sold grouped by POS category with quantities, discounts and totals | `report_sale_details.get_sale_details` | P0 | L | The canonical "Z report" content. Must include combo component labelling. |
| BOF-161 | Sales details: taxes on sales and on refunds (base + amount per tax) | same | P0 | M | Refunds are a **separate** section, not negative sales rows. |
| BOF-162 | Sales details: payments per method with expected / counted / difference, plus cash movement detail | same | P0 | M | Includes opening float, cash in/out list, and closing differences. |
| BOF-163 | Sales details: discounts (count of discounted lines + total discount) | same | P1 | S | |
| BOF-164 | Sales details: invoice list and totals | `_get_invoice_total_list` | P1 | S | |
| BOF-165 | Session report (single session) with the session-control block (opening/closing notes, dates, state) | `pos.daily.sales.reports.wizard` | P0 | M | Title switches to "Daily Sales Report" for a single session. |
| BOF-166 | Per-employee breakdown of the session report | `pos_hr.add_report_per_employee` | P1 | M | |
| BOF-167 | PDF rendering + printing of these reports (also to the receipt printer) | `sale_details_report` qweb-pdf | P0 | M | |
| BOF-168 | Order analytics: pivot/graph over line-level facts | `report.pos.order` SQL view | P1 | L | Measures: total incl. tax (currency-normalized), subtotal excl., pre-discount subtotal, total discount, average price, margin, quantity, line count, validation delay, order count. Dimensions: date, order, customer, product, product template, product category, POS category, state, user/employee, company, invoiced, register, pricelist, session, first payment method. Build it as a materialized fact table, not a live view over orders. |
| BOF-169 | Saved analytic views/filters (e.g. "per session") | search view defaults | P2 | S | |
| BOF-170 | Sales dashboard: revenue, covers, average ticket, top products, hourly heatmap, payment mix | *(new / spreadsheet dashboards in Odoo)* | P1 | L | The single most-requested screen by owners; Odoo's community answer is weak. |
| BOF-171 | Product mix / menu engineering report (popularity × margin quadrants) | *(new)* | P2 | M | |
| BOF-172 | Cashier performance report (sales, discounts given, voids, refunds, tips) | *(new; partly `pos_hr`)* | P1 | M | Doubles as a fraud-detection tool. |
| BOF-173 | Void/refund/discount exception report | derived from REG-123 | P1 | M | |
| BOF-174 | Tips report per employee/shift | RST-129 | P2 | M | |
| BOF-175 | Kitchen performance report (prep times per station, late rate) | KDS-022 | P2 | M | |
| BOF-176 | Scheduled email delivery of daily reports | `digest` KPI in Odoo | P2 | M | |
| BOF-177 | Export of any report to CSV/XLSX | Odoo generic export | P1 | M | |

## 5.7 Documents & templates (BOF-190 … BOF-199)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| BOF-190 | Receipt template customization (header/footer, logo, field toggles, per-register) | `receipt_header/footer`, config flags | P1 | L | Odoo hardcodes the layout in an OWL component. We should expose a constrained template (block toggles + free text), *not* raw HTML — raw HTML in a receipt breaks thermal printers. |
| BOF-191 | Kitchen ticket template customization | `OrderChangeReceipt` | P2 | M | |
| BOF-192 | Invoice template | invoice report | P1 | M | |
| BOF-193 | Email templates (receipt, self-order confirmation per preset) | `mail.template`, preset `mail_template_id` | P1 | M | |
| BOF-194 | SMS template | `pos_sms` | P2 | S | |
| BOF-195 | Report/receipt localization per language | translated templates | P1 | M | |

---

# 6. XCT — Cross-cutting

## 6.1 Offline & PWA (XCT-001 … XCT-029)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-001 | Service worker with app-shell precache and network-first-with-cache-fallback for GETs | `app/service_worker.js` | P0 | L | Odoo explicitly **excludes** RPC endpoints from the cache (data lives in IndexedDB). Caching a data response by accident is the classic way to serve a stale menu forever. |
| XCT-002 | Installable PWA per register (scoped app, manifest, icons) | `/scoped_app?...`, `isDisplayStandalone()` | P0 | M | Hide the install prompt when already installed. Separate scopes for register / KDS / self-order. |
| XCT-003 | IndexedDB replica: one store per entity, `id`-keyed for server entities, `uuid`-keyed for client-created entities | `indexed_db.js`, `data_service_options.js` | P0 | XL | The static/dynamic split is the foundation of the whole offline design. Batch writes (Odoo uses 500/transaction) and handle schema upgrades when a new entity appears. |
| XCT-004 | Debounced snapshot persistence of dynamic records, with **immediate flush** on offline payment | `synchronizeLocalDataInIndexedDB` (300 ms) | P0 | M | Retention rule: an order is kept locally until it is finalized **and** synced, or cancelled. |
| XCT-005 | Offline boot from cache when the session is already open | boot short-circuit on `session.state === "opened"` | P0 | L | Includes rehydrating draft/unsynced orders, recursively fetching missing referenced records once online, and purging orders whose products no longer load. |
| XCT-006 | Queued-and-replayed mutations for non-order operations (cash in/out, opening control) | `network.unsyncData`, `syncData` mutex | P0 | M | Replayed **in order**, with a mutex. Order sync deliberately uses a different mechanism (XCT-010). |
| XCT-007 | Connectivity detection: browser events + active ping + 2 s retry loop | `/pos/ping`, `data.network` | P0 | M | `navigator.onLine` is not sufficient (captive portals, server down). Odoo pings. |
| XCT-008 | Offline banner + degraded-feature messaging | offline banner | P0 | S | Every blocked action must say *why* and *what still works*. |
| XCT-009 | Unload protection when offline or with unsynced paid orders | `beforeunload` guards, `localUnsyncedPaidOrderUuids` | P0 | M | |
| XCT-010 | Idempotent order sync: one order at a time, UUID-keyed, safe to retry | `sync_from_ui`, uuid unique constraints | P0 | XL | Server rewrites "create" commands for already-existing UUIDs into "update" commands — that is what makes a duplicated retry harmless. Orders already non-draft are ignored and their id returned. |
| XCT-011 | UUID relation mapping so new child records can reference new parents before ids exist | `relations_uuid_mapping` | P0 | L | |
| XCT-012 | Pending-order queue with per-order locks and re-entry on boot | `pos.pendingOrder`, `syncingOrders` | P0 | M | Paid-but-unsynced orders must re-enter the queue on **every** boot. |
| XCT-013 | Recovery path when a device's session was closed while it was offline | rescue session return path | P0 | M | The server transparently returns a different (rescue) session and the client adopts it. |
| XCT-014 | Local data reset / repair tooling | `reloadData(fullReload)` | P1 | M | |
| XCT-015 | Storage-pressure handling (quota errors, iOS "IDB server lost" reload) | iOS reload dialog, visibility probe | P1 | M | Safari/iOS evicts IndexedDB aggressively; without the probe the app silently stops persisting. |
| XCT-016 | Defined list of online-only operations and their offline UX | §3.4 of the frontend inventory | P0 | M | Online-only: session open/close, server search, customer create (unless XCT-017), invoicing, receipt email/SMS, dynamic QR payment, terminals, refund of uncached orders, product info stock, lot availability. |
| XCT-017 | Offline customer creation with later reconciliation | *(improvement over Odoo)* | P1 | L | Needs a duplicate-detection/merge story before it ships. |

## 6.2 Realtime (XCT-030 … XCT-049)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-030 | Websocket infrastructure with token-scoped channels and auto-resubscribe on reconnect | Odoo bus + `getOnNotified` | P0 | L | Laravel Reverb (or Soketi) + private channels authorized by register/device token. Must resubscribe every channel on reconnect, not just the last one. |
| XCT-031 | Event catalogue: order sync fan-out, session closing, customer display, product changed, order state changed, orders removed, kiosk status, payment status | bus event names | P0 | M | Version the payloads; a mixed-version fleet is normal during rollout. |
| XCT-032 | Echo suppression by originating device identifier | `notify_synchronisation(device_identifier)` | P0 | S | |
| XCT-033 | Realtime as an optimization, never as the source of truth | Odoo pattern (`ONLINE_PAYMENTS_NOTIFICATION` sends only an id) | P0 | M | Every push must be re-validated by an authenticated fetch. Bus payloads are not trusted. |
| XCT-034 | Polling fallback when websockets are blocked | *(new)* | P1 | M | Restaurant wifi and corporate proxies block websockets more often than you would think. |

## 6.3 Hardware (XCT-050 … XCT-079)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-050 | Receipt printer abstraction with pluggable drivers | `printer_service`, `HWPrinter`, `EpsonPrinter` | P0 | L | |
| XCT-051 | Driver: browser print (fallback, always available) | `webPrintFallback` | P0 | M | |
| XCT-052 | Driver: Epson ePOS network printer (direct HTTP to the printer) | `EpsonPrinter`, ePOS XML | P1 | L | Includes response status parsing: paper out, cover open, near-end warning. |
| XCT-053 | Driver: IoT/proxy print bridge | `hw_proxy` | P2 | M | |
| XCT-054 | Driver: local print agent (our own small helper for USB/serial ESC-POS) | *(new)* | P1 | L | Odoo's answer is the IoT box; a small cross-platform agent is cheaper for customers and removes the raster-image hack. |
| XCT-055 | Render pipeline: component → offscreen DOM → canvas → raster, with font and image readiness gates | `render_service`, `htmlToCanvas` | P1 | L | |
| XCT-056 | Monochrome dithering for raster receipts | Floyd–Steinberg in `EpsonPrinter` | P2 | M | |
| XCT-057 | Cash drawer control (pulse via printer or proxy), triggered on cash payment, cash movement, and counts | `openCashbox()`, `iface_cashdrawer` | P0 | M | Every manual open is logged (REG-050). |
| XCT-058 | Electronic scale integration with continuous polling and tare | `pos_scale`, `scale_read` (500 ms) | P1 | M | Legal-metrology weight-change rule (REG-077). |
| XCT-059 | Barcode scanner support: HID wedge, camera, proxy | XCT/REG-080..082 | P0 | M | |
| XCT-060 | Payment terminal driver registry | `register_payment_method`, `PaymentInterface` | P1 | L | Interface must cover: send, cancel, reverse, force-done, status polling, **adjust (tip)**. |
| XCT-061 | Hardware status panel (printer, drawer, scale, scanner, terminal reachability) | `ProxyStatus` | P1 | M | |
| XCT-062 | Local Network Access / private-network permission flow | `init_lna.js` | P1 | M | |
| XCT-063 | Printer discovery/configuration helper and test print | `epson_printer_ip` derivation, test widget | P2 | M | Odoo derives an Epson "certified domain" from the printer serial for HTTPS — a real-world necessity for browser-to-printer TLS. |

## 6.4 Internationalization & money (XCT-080 … XCT-099)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-080 | UI translations for register, KDS, self-order and back office | Odoo i18n + `res.lang` | P0 | L | Self-order needs per-register available languages and a customer-facing switcher. |
| XCT-081 | Translatable content: product names, descriptions, categories, presets, notes, payment methods | Odoo translated fields | P1 | L | Decide the storage model now (JSON columns vs translation table); retrofitting is painful. |
| XCT-082 | Locale-aware number, currency and date formatting, including decimal-separator handling in the numpad | `contextual_utils_service`, `NumberBuffer` | P0 | M | |
| XCT-083 | RTL layout support | Odoo web | P2 | M | |
| XCT-084 | Currency configuration (symbol, position, rounding, decimal places) | `res.currency` | P0 | S | |
| XCT-085 | Multi-currency: register currency vs company currency, conversion at order date | `currency_rate` on orders/payments | P2 | L | Odoo stores the rate **on the order** so historical documents never drift. Do the same even if we only support one currency at launch. |
| XCT-086 | Tax regimes / fiscal positions per country | `account.fiscal.position` | P1 | M | |
| XCT-087 | Country-specific receipt requirements hooks (VAT label, legal mentions, fiscal signature) | `vat_label`, l10n modules | P1 | L | Design an extension point now; several EU countries require certified fiscal modules and Odoo handles this in per-country modules. |

## 6.5 Tenancy, security & audit (XCT-100 … XCT-129)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-100 | Multi-store: many registers under one company/brand, shared or per-store catalogue | `pos.config` per store | P0 | L | Decide early whether catalogue is global with per-store overrides (recommended) or per-store. Odoo's model is "global products + per-register availability", which works well. |
| XCT-101 | Multi-company / multi-tenant isolation | Odoo record rules per company | P0 | XL | Every query scoped by tenant; enforced at the query-builder layer, not per controller. |
| XCT-102 | Per-store overrides: prices (pricelists), availability, taxes, printers, floors | pricelists + register config | P1 | L | |
| XCT-103 | Cross-store consolidated reporting | `report.pos.order` multi-config | P1 | M | |
| XCT-104 | Authentication for staff (back office + register) with sessions and refresh | Odoo auth | P0 | M | |
| XCT-105 | Ability/permission system with role presets | Odoo groups + code-level gates | P0 | L | Must be evaluable **offline** in the register from loaded data, and re-validated server-side on sync. |
| XCT-106 | Public/anonymous surface hardening: token comparison in constant time, rate limiting, payload whitelisting | self-order controllers | P0 | M | |
| XCT-107 | Server-side revalidation of everything the client computed (prices, taxes, totals, permissions) | `_compute_prices`, `_check_pos_order` | P0 | L | "We don't trust the client" is written into Odoo's source; make it a test suite. |
| XCT-120 | Audit trail: who did what, when, on orders, sessions, cash, configuration, prices | chatter + `log_partner_message` + edit tracking | P1 | L | Append-only table, exportable, retained per policy. Covers voids, discounts, price overrides, refunds, drawer opens, config changes, permission overrides. |
| XCT-121 | Sequential document numbering guarantees (orders, invoices) with gap explanation | Odoo `ir.sequence` no-gap | P1 | M | No-gap invoice numbering is a legal requirement in many countries and conflicts with offline creation — resolve by numbering invoices server-side only. |
| XCT-122 | Data retention & GDPR: customer data export/erase, receipt anonymization | *(new)* | P2 | M | |
| XCT-123 | Backup/restore and per-tenant data export | *(new)* | P1 | M | |

## 6.6 Platform & delivery (XCT-130 … XCT-149)

| ID | Feature | Odoo ref | P | Cx | Parity note |
|---|---|---|---|---|---|
| XCT-130 | Data bootstrap contract: per-entity payload definitions with register-scoped filters, field whitelists and relation metadata | `pos.load.mixin` (`_load_pos_data_domain/_fields/_read`) | P0 | XL | This is the single most important architectural pattern to port. One place per entity defines *what the register may see*; the client builds its mini-ORM from the relation metadata. Reproduce it as a "POS payload" resource layer with the same three hooks, plus a parallel self-order variant (`_load_pos_self_data_*`) that returns a *narrower* set to anonymous clients. |
| XCT-131 | Client-side relational store with reactive records, dirty tracking, indexed lookups and ORM-command serialization | `related_models`, `serializeForORM` | P0 | XL | React equivalent: a normalized store (Zustand/Valtio + custom indexes) with the same record semantics. |
| XCT-132 | Extension points mirroring Odoo's patch registries (pages, models, payment drivers, validation hooks) | `pos_pages`, `pos_available_models`, `register_payment_method` | P1 | L | Restaurant, self-order and loyalty are all built as patches in Odoo; if we hardcode restaurant logic into the register we will pay for it forever. |
| XCT-133 | Shared calculation core used by client and server (taxes, pricelists, combos, rounding) | duplicated in Odoo (JS + Python) | P0 | XL | Options: (a) implement twice with a shared fixture suite (Odoo's approach), (b) compile one TS implementation and run it server-side. Decide in Phase 0; the fixture suite is mandatory either way. |
| XCT-134 | Performance budgets and instrumentation (boot time, search latency, add-to-cart latency, sync latency) | — | P0 | M | Targets: cold boot ≤ 5 s, warm boot ≤ 1.5 s, add-to-cart ≤ 100 ms, search keystroke ≤ 50 ms on a mid-range Android tablet with 5000 products. |
| XCT-135 | Automated test strategy: shared calculation fixtures, E2E flows mirroring Odoo's tours, offline simulation, multi-device simulation | Odoo tours + unit tests | P0 | L | Odoo's tour list (`floor_screen_tour`, `split_bill_screen_tour`, `tip_screen_tour`, `devices_synchronization_tour`, `refund_tour`, …) is a ready-made E2E backlog. |
| XCT-136 | Observability: client error reporting, sync failure metrics, printer failure metrics, session anomaly alerts | — | P1 | M | |
| XCT-137 | Data migration tooling from Odoo (catalogue, customers, floors/tables, historical orders) | — | P1 | L | Historical orders can be imported read-only into the analytics fact table without importing the full order model. |
| XCT-138 | Release/rollout: staged deployment, forced client refresh, schema/version negotiation between client and server | `_server_version` in the payload | P1 | M | An old cached client talking to a new server is the normal state during a rollout; version-negotiate and force-reload when incompatible. |

---

# 7. Feature count summary

| Area | Leaf features | P0 | P1 | P2 |
|---|---|---|---|---|
| REG — Register | 212 | 69 | 81 | 62 |
| RST — Restaurant | 80 | 28 | 36 | 16 |
| KDS — Kitchen | 39 | 22 | 12 | 5 |
| SLF — Self-order | 69 | 23 | 30 | 16 |
| BOF — Back-office | 84 | 30 | 37 | 17 |
| XCT — Cross-cutting | 65 | 36 | 23 | 6 |
| **Total** | **549** | **208** | **219** | **122** |

Counts are generated from the tables above (`grep -cE "^\| PREFIX-[0-9]{3} \|"`); regenerate them whenever
features are added. They move as sub-features are split out during design.

**Rough sizing.** Using S=1, M=3, L=8, XL=20 person-days as a planning heuristic, the P0 set alone is on the
order of 4–5 person-years of engineering before hardening — which is why §8 (out of scope) matters as much as
the matrix itself, and why Phase 0 must not be compressed.

---

# 8. Deliberately out of scope

We are building a restaurant POS, not an ERP. Everything below exists in Odoo's POS surface and is
**intentionally not** part of this product. Each entry states what we do instead.

## 8.1 Accounting depth

| Odoo functionality | Ref | Why we drop it | What we do instead |
|---|---|---|---|
| Double-entry journal entries for the session closing (`_create_account_move`, `_accumulate_amounts`) | `pos.session._validate_session` | Reimplementing a general ledger is a multi-year project and duplicates the accounting system every customer already has. | A structured, immutable **session summary** (sales per tax/category/product, payments per method, cash reconciliation, discounts, refunds) plus a documented export (CSV/JSON/API) that an accounting system or connector consumes. |
| Chart of accounts, account mapping per product/category/journal | `account.account`, income accounts on products | Same. | Optional per-product/category "accounting code" strings passed through to the export, unvalidated by us. |
| `account.payment` creation, outstanding accounts, bank reconciliation | payment moves at closing | Bank reconciliation belongs in accounting software. | Payment totals per method, per session, with terminal references, in the export. |
| Anglo-saxon COGS postings, stock valuation entries | `_create_account_move` stock lines | Requires a full inventory valuation engine. | Cost snapshot per line (for margin reporting) only. |
| Cash-basis tax exigibility, storno moves, reversal entries against the closing entry when invoicing late | `_create_misc_reversal_move` | Artifacts of the journal-entry design we are not adopting. | Invoicing a closed-session order simply produces the invoice and flags the order; the session summary is regenerated with an "invoiced after close" line. |
| Payment terms, partner receivable/payable ledgers | invoice payment terms | ERP scope. | Simple "on account" balances per customer (REG-208) with a statement view; no ageing/dunning. |
| Multi-journal configuration, fiscal-year locks, lock dates | `account.journal`, lock date checks | ERP scope. | A simple "period closed" flag preventing edits to past sessions. |

**Consequence to design for:** the session summary must be *reproducible and immutable*. Once a session is
closed, its summary is frozen and versioned; later changes (late invoicing, tip settlement) append
adjustment records rather than mutating history.

## 8.2 Inventory depth

| Odoo functionality | Ref | Why we drop it | What we do instead |
|---|---|---|---|
| `stock.picking` / `stock.move` / `stock.move.line` generation per order | `_create_order_picking` | Full WMS semantics (reservations, procurement rules, routes, multi-step delivery) are irrelevant to a restaurant. | A single-location quantity ledger: decrement on sale, increment on refund, with a manual adjustment screen. |
| Multi-warehouse, routes, procurement, ship-later via stock rules | `route_id`, `_launch_stock_rule_from_pos_order_lines` | Same. | Ship-later records a delivery date and a simple fulfilment record (REG-326). |
| Lot/serial traceability with `stock.quant` availability checks | `pos.pack.operation.lot`, `get_existing_lots` | Rarely used in restaurants; heavy. | Optional free-text lot capture per line (REG-076, P2) with no availability enforcement. |
| FIFO/AVCO costing from stock moves, real-time valuation | `_compute_total_cost_in_real_time` | Requires a valuation engine. | Standard cost per product for margin reporting; recipe/BOM costing is a future module, not parity. |
| Purchase orders, suppliers, replenishment, reordering rules | `stock.rule` triggers at closing | ERP scope. | Out. Supplier info shown read-only in the product panel if imported. |
| Recipes / bill of materials depletion (mrp) | not in POS | Not in Odoo POS either, but customers ask. | Explicitly a future module; the stock ledger design should not preclude it. |

## 8.3 ERP / platform modules

| Dropped | Why |
|---|---|
| Odoo's ORM, module system, QWeb, OWL, asset bundles, chatter, activities, mail framework | We are rewriting, not porting. Chatter is replaced by the typed audit trail (XCT-120); activities by notifications. |
| `res.config.settings` proxy-field architecture | Replaced by direct, validated settings on the register record (BOF-030). |
| Odoo Studio / customization framework, server actions, automated actions | Out. |
| Odoo portal, website, eCommerce integration | Out. Self-order (SLF) is our customer-facing surface. |
| Odoo Sign, Documents, Knowledge, Appointments (`module_pos_appointment`) | Out. |
| Digest emails, `kpi_pos_total` | Replaced by BOF-176 scheduled reports. |
| `pos_avatax`, `pos_pricer` (electronic shelf labels), country-specific fiscal modules | Out of the core; XCT-087 keeps an extension point. |
| IoT Box as a product | We support the protocol (XCT-053) but ship our own lighter print agent (XCT-054). |

## 8.4 Marketing & CRM modules

| Dropped | Why | Note |
|---|---|---|
| `pos_loyalty` + `loyalty` (programs, coupons, promotions, gift cards, eWallet, points, communication plans) | Very large (programs × rules × rewards × cards × mail plans) and orthogonal to core POS quality. | **Deferred, not refused** — REG-184 reserves the data-model hooks so a post-1.0 module does not force a migration. |
| Email marketing, SMS marketing, campaigns | ERP scope. | Transactional email/SMS for receipts only (REG-250/251). |
| CRM pipeline, leads, opportunities | ERP scope. | |
| Subscriptions, memberships, events | ERP scope. | |
| `link.tracker` analytics | Only the short-link generation is kept (SLF-013), not the analytics. |

## 8.5 Retail-specific POS features we deprioritize

| Dropped / deferred | Why |
|---|---|
| Deep variant matrices and made-to-order variant creation (REG-074 kept at P2) | Restaurants use attributes, not variant matrices. |
| Electronic scale certification beyond the weight-change rule | Country-specific certification is a separate compliance project. |
| Product tags/publishing to a webshop | No webshop. |
| Sample/demo data generators (Odoo's clothes/bakery/furniture scenarios) | Replaced by one restaurant demo dataset. |

## 8.6 Explicitly *in* scope despite being enterprise-only in Odoo

Stated here so nobody "reduces scope" by mistake:

- **KDS (§3.1)** — enterprise-only in Odoo 19 (`pos_enterprise`, `pos.prep.*`). We build it, and it is P0.
- **Customer-facing order status (SLF-083)** — does not exist in Odoo. We build it.
- **Owner dashboard & menu-engineering reporting (BOF-170/171)** — weak in Odoo community. We build it.
- **Offline customer creation (XCT-017)** and **polling fallback (XCT-034)** — improvements over Odoo.

---

# 9. Phased delivery roadmap

Phases are sequential for the *critical path* but overlap in practice (back-office CRUD for an entity is
built alongside the register feature that consumes it). Each phase ends with a demoable, testable build.

---

## Phase 0 — Foundation

**Goal.** Establish the architecture that every later phase depends on: the data-bootstrap contract, the
offline replica, the shared calculation core, and the sync protocol. No user-facing POS features ship.
This phase is deliberately long; every shortcut taken here is repaid tenfold in Phase 6.

**Included:** XCT-130, XCT-131, XCT-133, XCT-134, XCT-135, XCT-138, XCT-003, XCT-010, XCT-011,
XCT-030, XCT-031, XCT-032, XCT-033, XCT-100, XCT-101, XCT-104, XCT-105, XCT-107,
REG-118, REG-115, REG-116, REG-371 (identity/numbering primitives),
REG-174 + REG-177 (tax + precision core), REG-170/171 (pricelist core), REG-075 combo math core,
BOF-006 (register CRUD, minimal), BOF-091/092 (taxes, fiscal positions, minimal admin).

**Exit criteria.**
1. A React client boots against a seeded tenant, loads a register payload, and materializes it into
   IndexedDB; a second boot with the network disabled reproduces the same in-memory state.
2. The shared fixture suite (≥ 200 cases: price-included/excluded taxes, tax groups, children taxes,
   cash rounding, combos, pricelist formulas, refund signs) passes **identically** in PHP and TypeScript.
3. A synthetic order created offline, duplicated 3×, and pushed after reconnect results in exactly one
   server order (UUID idempotency proven under retry and concurrency).
4. Realtime events fan out to two connected clients with echo suppression verified.
5. Tenant isolation proven by an automated test that fails if any query lacks a tenant scope.
6. Performance harness in CI reporting boot/search/add-line timings against a 5000-product fixture.

---

## Phase 1 — Core register MVP

**Goal.** A single cashier can open a register, sell, take payment, print, refund, and close — fully
offline-capable. This is the first build that could run a coffee counter.

**Included:**
- Session & cash: REG-001…REG-024 (all), REG-040, REG-043, REG-045, REG-048, REG-049.
- Catalogue: REG-060…REG-062, REG-064…REG-072, REG-073, REG-075, REG-077 (if scale in pilot), REG-080, REG-083, REG-088, REG-089.
- Lines: REG-100…REG-125.
- Customers: REG-150…REG-152, REG-155, REG-157, REG-158.
- Pricing: REG-173, REG-175, REG-176, REG-178, REG-180, REG-182, REG-183.
- Payments: REG-200…REG-208, REG-216…REG-220.
- Receipts: REG-240…REG-242, REG-245…REG-249, REG-252, REG-254.
- Refunds: REG-270…REG-274, REG-276.
- Order list: REG-290…REG-297, REG-300.
- Presets: REG-335…REG-337.
- Sync/offline: REG-365…REG-371, REG-373…REG-376, XCT-001, XCT-002, XCT-004…XCT-009, XCT-012, XCT-013, XCT-016, XCT-051, XCT-057, XCT-059, XCT-082, XCT-084.
- Back-office minimum to operate: BOF-001…BOF-003, BOF-030…BOF-033, BOF-036…BOF-038, BOF-080…BOF-084, BOF-088, BOF-110, BOF-117, BOF-118, BOF-130, BOF-131, BOF-133.

**Exit criteria.**
1. Full sell→pay→print→close cycle completed with the network disconnected for the entire session,
   reconnecting only at close; zero data loss, zero duplicates.
2. Session close produces a summary whose totals reconcile to the cent with the sum of orders, for a
   scripted 200-order session including refunds, discounts, mixed payments and cash rounding.
3. A refund of a partially-refunded order is correctly capped and linked.
4. Two devices selling on the same register do not collide on order references and both see each
   other's orders within 2 s.
5. Cashier role gates verified server-side (a tampered client cannot change a price when
   `restrict_price_control` is on).
6. Performance budgets (XCT-134) met on the target tablet.

---

## Phase 2 — Restaurant

**Goal.** Table service: floors, tables, courses, transfers, splitting, tips, proforma bills.

**Included:** RST-001…RST-015, RST-030…RST-040, RST-050…RST-059, RST-070…RST-074,
RST-080…RST-090, RST-100…RST-106, RST-110, RST-111, RST-120…RST-127, RST-140…RST-146,
plus REG-119/120 refinements for table orders, REG-209 (fast payment with the unsent-changes prompt),
REG-298, BOF-041, BOF-116, BOF-113, BOF-112.

**Exit criteria.**
1. A waiter opens a table, adds items across three courses, transfers the order to another table,
   merges it with an existing order, splits the bill in two, and pays both parts — with correct totals,
   correct guest counts, and no duplicated or lost lines.
2. Table linking followed by unlinking restores the original per-table orders and courses exactly
   (line quantities, course indices, fired flags).
3. Two devices editing the same table concurrently converge on one order; the duplicate is merged into
   the oldest synced order and deleted.
4. Tip-after-payment flow completes on a card payment, including the signature slip and the bulk
   settlement screen.
5. Proforma bill prints without incrementing the print counter and carries the "Pro forma" banner.
6. All Phase 1 exit criteria still pass (regression gate).

---

## Phase 3 — Kitchen

**Goal.** Orders reach the kitchen reliably, by screen and by printer, with correct deltas.

**Included:** KDS-050…KDS-064 (delta engine and printing) **first**, then KDS-001…KDS-024 (display).
Plus REG-297, RST-143…RST-146 integration, BOF-114, BOF-115, BOF-039, BOF-191, XCT-052, XCT-054,
XCT-061, XCT-062, XCT-063.

Rationale for the ordering: the delta engine (KDS-051) is the contract the display consumes; building the
display first would mean building it twice.

**Exit criteria.**
1. Delta-engine fixture suite passes: additions, partial removals, full deletions, note-only changes,
   order-note changes, combo grouping, course grouping, and the `uuid+note` keying rule.
2. Sending an order twice in a row produces no second ticket; adding one item produces a ticket with
   exactly that item; reducing a sent quantity produces a cancellation ticket.
3. Two devices sending the same table simultaneously: the second is blocked with "Order outdated",
   adopts the server snapshot, and prints nothing.
4. Transfer, merge and split all migrate the sent-quantity history so the kitchen receives no
   spurious tickets (verified by ticket-count assertions).
5. KDS shows a fired course within 1 s, supports bump/recall, and survives a 60 s network outage with
   queued state changes reconciled on reconnect.
6. Printer failure produces a retry dialog and never double-prints an already-successful printer.

---

## Phase 4 — Self-order

**Goal.** Customers can browse, order and (optionally) pay from a QR code or a kiosk, and those orders
land correctly in the register and the kitchen.

**Included:** SLF-001…SLF-015, SLF-020…SLF-044, SLF-060, SLF-064, SLF-065, SLF-080…SLF-085,
SLF-110…SLF-115, BOF-042, plus SLF-083 (customer status, depends on KDS-019),
then the payment extensions SLF-061, SLF-062, SLF-066, SLF-067 and the kiosk set
SLF-004, SLF-090…SLF-098, SLF-063.

Suggested split: **4a** = consultation + mobile ordering with pay-at-counter (the highest-value,
lowest-risk slice); **4b** = online payment; **4c** = kiosk.

**Exit criteria.**
1. A customer scans a table QR, orders across two rounds in `meal` mode, and both rounds append to a
   single draft order visible on the correct table in the register.
2. Two phones at the same table converge on one order without losing either customer's items.
3. Server-side price recomputation rejects a tampered client payload (modified price, modified tax,
   modified combo composition) and the resulting order totals match the register's computation.
4. Items already submitted by the customer are never re-sent to the kitchen by the cashier.
5. Online payment completes end to end, creates the payment line only from the confirmed transaction,
   and prints the receipt exactly once even with two cashier devices listening.
6. Kiosk survives an idle timeout mid-order without leaking the previous customer's basket.
7. Public endpoints pass a security review: constant-time token comparison, rate limiting, payload
   whitelisting, service-user scoping, no privilege escalation.

---

## Phase 5 — Back-office & reporting

**Goal.** Owners and managers can configure, audit and understand the business without touching the
database.

**Included:** remaining BOF items — BOF-004, BOF-005, BOF-007, BOF-008, BOF-034, BOF-035,
BOF-039 (finish), BOF-040, BOF-043…BOF-045, BOF-085…BOF-090, BOF-093, BOF-094, BOF-111,
BOF-119, BOF-120, BOF-132, BOF-134…BOF-139, BOF-160…BOF-177, BOF-190…BOF-195.
Plus REG-310…REG-317 (invoicing), REG-325…REG-328 (ship-later/stock ledger), REG-338…REG-341
(scheduling), XCT-120, XCT-121, XCT-123, and BOF-177 exports.

**Exit criteria.**
1. The sales-details/session report reconciles exactly with the session summary and with the sum of
   orders for a scripted session containing refunds, discounts, multiple tax rates, cash rounding,
   cash movements, and an order invoiced after closing.
2. Order analytics returns correct measures for a 100k-line fact table within the performance budget.
3. Every register setting is editable in the UI, validated, and locked appropriately while a session
   is open; changing a locked setting mid-session is impossible through the API too.
4. The audit trail records and displays: voids, discounts above threshold, price overrides, refunds,
   drawer opens, permission overrides, configuration changes — with actor, timestamp and before/after.
5. Menu import/export round-trips a 500-item menu with categories, attributes, combos and prices.
6. Owner dashboard renders yesterday's trading on a phone in under 2 s.

---

## Phase 6 — Hardening: offline, performance, hardware, compliance

**Goal.** Make it survive real restaurants: bad wifi, cheap tablets, thermal printers, long sessions,
and auditors.

**Included:** XCT-014, XCT-015, XCT-017, XCT-034, XCT-050 driver completion, XCT-053, XCT-055,
XCT-056, XCT-058, XCT-060, XCT-080…XCT-087, XCT-102, XCT-103, XCT-106 (re-review), XCT-122,
XCT-136, XCT-137, KDS-020…KDS-024, REG-350…REG-356 (customer display), REG-372 (trusted registers),
REG-184 groundwork if the loyalty module is greenlit, plus all deferred P2s that survived triage.

**Exit criteria.**
1. **Chaos suite** passes: random network partitions, server restarts, tab kills, device clock skew,
   storage eviction, and clock-forward jumps during a 500-order simulated service — zero lost orders,
   zero duplicates, zero corrupted sessions.
2. 12-hour continuous session on the target tablet with no memory growth beyond budget and no
   IndexedDB bloat (retention/GC verified).
3. Printer matrix validated across at least three thermal printer models plus browser print, including
   paper-out and cover-open handling.
4. Localization verified for at least three languages including one RTL smoke test; currency and
   number formatting verified per locale.
5. Multi-store tenant with 10 registers and 3 stores passes isolation, consolidated reporting and
   per-store override tests.
6. Security review and penetration test of the public self-order surface and the device-token surfaces
   completed with no high findings.
7. Documented disaster recovery: restore a tenant from backup and reconcile in-flight offline devices.

---

## 9.1 Cross-phase risk register (top 8)

| Risk | Phase | Mitigation |
|---|---|---|
| Tax/pricing divergence between client and server | 0 | Shared fixture suite in CI (XCT-133); server always authoritative. |
| Offline sync data loss or duplication | 0/1/6 | UUID idempotency + retention rules + chaos suite; rescue sessions (REG-021). |
| Kitchen delta engine bugs producing double or missing tickets | 3 | Fixture suite; ticket-count assertions across transfer/merge/split. |
| Combo pricing mismatch (register vs self-order vs invoice) | 0/4 | One implementation, fixtures, server recomputation. |
| Thermal printing reliability and layout drift | 3/6 | Own print agent (XCT-054), printer matrix testing, snapshot receipt tests. |
| Scope creep from "just add accounting" | all | §8 is a contract; the export is the answer. |
| Multi-device concurrency on tables | 2 | Server-side one-draft-per-table rule + deterministic merge on the oldest synced order. |
| Performance on cheap Android tablets | 0/1/6 | Budgets in CI from Phase 0, virtualized lists, indexed search, batched recomputation. |

---

## Appendix A — Odoo → our terminology

| Odoo | Ours |
|---|---|
| `pos.config` | Register |
| `pos.session` | Session / shift |
| `pos.order`, `pos.order.line` | Order, order line |
| `pos.payment`, `pos.payment.method` | Payment, payment method |
| `pos.category` | Menu category |
| `product.template` / `product.product` | Menu item / item variant |
| `product.combo(.item)` | Combo / combo choice |
| `pos.preset` | Service mode |
| `pos.printer` | Prep station (printer) |
| `pos.prep.*` (enterprise) | KDS / prep station (display) |
| `restaurant.floor` / `restaurant.table` | Floor / table |
| `restaurant.order.course` | Course |
| `pos.note` | Quick note |
| `pos.bill` | Denomination |
| `pos.load.mixin` | POS payload contract |
| `last_order_preparation_change` | Kitchen snapshot |
| chatter / `mail.thread` | Audit trail |
