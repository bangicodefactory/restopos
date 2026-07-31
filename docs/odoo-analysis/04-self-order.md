# 04 — Self-Order Inventory (pos_self_order, pos_online_payment, pos_online_payment_self_order)

Source analyzed: Odoo 19 (branch 19.0) addons at:
- `/home/claude/odoo19/addons/pos_self_order`
- `/home/claude/odoo19/addons/pos_online_payment`
- `/home/claude/odoo19/addons/pos_online_payment_self_order`

Note: these three addons were not present in the local checkout (only `point_of_sale` was); they were fetched from the official `odoo/odoo` 19.0 branch and copied into `/home/claude/odoo19/addons/` so all paths below are real local paths.

Manifest facts:
- `pos_self_order` depends on `pos_restaurant`, `http_routing`, `link_tracker`; auto-installs with `pos_restaurant`.
- `pos_online_payment` depends on `point_of_sale`, `account_payment`; `auto_install: True`.
- `pos_online_payment_self_order` depends on both; `auto_install: True`. It is the glue module.

---

## 1. Self-order modes

Configured per POS via `pos.config.self_ordering_mode` (`models/pos_config.py`):

```python
self_ordering_mode = fields.Selection(
    [("nothing", "Disable"), ("consultation", "QR menu"),
     ("mobile", "QR menu + Ordering"), ("kiosk", "Kiosk")], default="nothing")
```

### 1.1 `consultation` — QR menu only
- URL `/pos-self/<config_id>` **without** access token (`_get_self_order_route` returns just the base route for consultation mode).
- The entry controller (`controllers/self_entry.py::_verify_entry_access`) returns `config_access_token = ''` for this mode, so the OWL app boots with an empty `odoo.access_token` → `SelfOrder.ordering` stays `false` → browse-only: products/categories/prices visible, no cart submission (order RPCs all require the config access token, and `_verify_pos_config` rejects any mode that isn't `mobile`/`kiosk`).
- Works even without an open POS session.

### 1.2 `mobile` — QR menu + ordering (self-order at table / smartphone)
- URL `/pos-self/<config_id>?access_token=<config.access_token>[&table_identifier=<table.identifier>]`.
- Requires an **open pos.session** for ordering (`_verify_config_constraint` checks `has_active_session`; entry page still renders when closed, showing a "We're currently closed" banner and disabling ordering).
- Sub-mode `self_ordering_service_mode`: `counter` ("Pickup zone") or `table`. With `table` + `module_pos_restaurant`, each restaurant table gets its own QR embedding its `table_identifier`.
- `self_ordering_pay_after`: `meal` (accumulate onto one draft order per table, pay at end) or `each` (pay/submit each order separately). Business rules enforced in `pos.config.write()` and `res.config.settings` onchanges:
  - kiosk ⇒ forced `each`;
  - mobile + counter service ⇒ forced `each`;
  - mobile without pos_restaurant ⇒ forced `each`;
  - mobile + `meal` ⇒ forces service mode `table`;
  - "Each" is labeled "(require Odoo Enterprise)" on community builds (`_compute_selection_pay_after`).
- Mobile mode uses IndexedDB persistence in the browser (PWA-ish offline cache of orders; see §6 data service).

### 1.3 `kiosk`
- Same app, same URL, but launched from the backend dashboard: `pos.config.action_open_wizard()` opens a session (if needed), notifies bus `STATUS {status:'open'}`, and opens `self_ordering_url` in a new tab.
- Kiosk constraints: cash payment methods forbidden (`_onchange_payment_method_ids` constraint), pay-after forced to `each`, `module_pos_restaurant` toggled off in settings onchange.
- Kiosk-only client behavior: idle timeout popup (90 s → `TimeoutPopup` → back to landing), receipt printing (Epson ePOS / IoT proxy printers), kitchen prep-ticket printing from the kiosk itself (`printKioskChanges`), language reset after each order, `STATUS` bus listener (session opened/closed → reload / disable ordering), paper-out tracking (`has_paper` field + `/pos-self-order/change-printer-status`), eat-in/take-out "presets" screen, stand-number screen (table tracker), payment-terminal payments (Adyen/Razorpay/Stripe/Pine Labs/Viva.com per `_supported_kiosk_payment_terminal()`).
- `close_ui()` override: closing a kiosk config deletes remaining draft orders and notifies `STATUS {status:'closed'}`.
- Cashier POS loads kiosk draft orders into its order list (`getServerOrdersDomain` override adds `source = 'kiosk'` draft orders when `session._self_ordering`).

### 1.4 Config options added on `pos.config` (full list)
| Field | Type | Purpose |
|---|---|---|
| `status` | Selection (computed) | active/inactive = has_active_session |
| `self_ordering_url` | Char (computed) | base_url + self-order route incl. access_token |
| `self_ordering_mode` | Selection | nothing / consultation / mobile / kiosk |
| `self_ordering_service_mode` | Selection | counter / table |
| `self_ordering_default_language_id` | M2o res.lang | default UI language |
| `self_ordering_available_language_ids` | M2m res.lang | selectable languages |
| `self_ordering_image_home_ids` | M2m ir.attachment | landing-page carousel images (defaults landing_01..03.jpg, forced `public=True`) |
| `self_ordering_image_background_ids` | M2m ir.attachment (rel `pos_self_order_background_rels`) | kiosk background image |
| `self_ordering_default_user_id` | M2o res.users | user whose access rights are used for all public self-order requests (must be POS user/manager — constraint) |
| `self_ordering_pay_after` | Selection meal/each | when customer pays |
| `self_ordering_image_brand` | Image (1200×250) | brand/logo header |
| `self_ordering_image_brand_name` | Char | brand name |
| `has_paper` | Boolean | kiosk printer paper status |
| (from glue module) `self_order_online_payment_method_id` | M2o pos.payment.method | online PM used by mobile self-order |

All are mirrored as `pos_*` related fields on `res.config.settings` (`models/res_config_settings.py`).

### 1.5 Tokens & QR codes
- **Config access token**: `pos.config.access_token = uuid4().hex[:16]` (defined in `point_of_sale/models/pos_config.py` line 192; pos.config inherits `pos.bus.mixin` whose Char field it overrides with a default). Embedded in every mobile/kiosk URL as `?access_token=`. It doubles as the **bus channel name** (see §4).
- **Table token**: `restaurant.table.identifier = uuid4().hex[:8]` (`models/pos_restaurant.py`), required, copy=False. `data/init_access.xml` regenerates all identifiers at install. Table QR URL = `/pos-self/<id>?access_token=<cfg>&table_identifier=<identifier>`. Child tables (merged) resolve to `parent_id` at entry.
- **Rotation**: `res.config.settings.update_access_tokens()` → `pos.config._update_access_token()` regenerates the config token **and** every table identifier (invalidates all printed QRs).
- **Order access token**: `pos.order.access_token = str(uuid4())` via `pos.bus.mixin._ensure_access_token` — per-order secret used by the client to track/pay/cancel its own orders and as the portal access token for the online-payment page.
- **QR generation** (server, `qrcode` lib, PNG+SVG): `_get_qr_code_data()` (per-floor/per-table, or 6 generic codes), `res.config.settings.generate_qr_codes_zip()` (ZIP + XLSX of URLs), `generate_qr_codes_page()` (printable PDF report `pos_self_order.report_self_order_qr_codes_page`, 3 per row), `get_pos_qr_order_data()` (POSTs data to odoo.com "QR stands" form). URLs are shortened through `link.tracker` (`_get_self_order_url`).
- PWA: `controllers/webmanifest.py` overrides web's scoped-app manifest — app name = POS config name (from `pos-self/<id>` path), icon = company logo (fallback POS icon). So the self-order app is installable as a scoped PWA.

---

## 2. Data model (fields/models added)

### 2.1 New model: `pos_self_order.custom_link`
`models/pos_self_order_custom_link.py` — configurable buttons on the landing page.
- `name` (Char, translate), `url` (Char), `pos_config_ids` (M2m pos.config, empty = all), `style` (Selection of 8 Bootstrap styles), `link_html` (computed Html preview), `sequence` (Int).
- ACL: manager rwcu, pos user read-only (`security/ir.model.access.csv`).
- A default "Order Now" link pointing at `/pos-self/<id>/products` is auto-created per config on create/write (`_prepare_self_order_custom_btn`).

### 2.2 Inherited models (pos_self_order)
- **pos.config** — see table §1.4 plus loading API: `_load_pos_self_data_fields` (whitelist of ~45 config fields sent to the client), `_load_self_data_models()` (the 35+ models loaded into the self app: pos.session, pos.preset, resource.calendar.attendance, pos.order, pos.order.line, pos.payment, pos.payment.method, res.partner, pos.printer, pos.category, product.template, product.product, product.combo, product.combo.item, res.company, account.tax, account.tax.group, res.country(+state), product.category, product.pricelist(+item), res.currency, account.fiscal.position, res.lang, product.attribute, product.attribute.custom.value, product.template.attribute.line, product.template.attribute.value, product.tag, decimal.precision, uom.uom, pos_self_order.custom_link, restaurant.floor, restaurant.table, account.cash.rounding, mail.template), `load_self_data()` / `load_data_params()` (data + relations payloads), extra client keys `_server_version`, `_self_ordering_image_home_ids`, `_self_ordering_image_background_ids`, `_pos_special_products_ids`, `_self_ordering_style` (primary bg/text colors from company email colors), `_self_order_pos`, `_base_url`.
- **pos.order** (`models/pos_order.py`):
  - `table_stand_number` (Char) — kiosk table-tracker number;
  - `self_ordering_table_id` (M2o restaurant.table, readonly) — table the QR was scanned at (kept in sync when cashier transfers the order to another table via `write` override);
  - `source` selection_add: `('mobile','Self-Order Mobile'), ('kiosk','Self-Order Kiosk')`;
  - `_check_pos_order()` — server-side sanitization of the incoming order payload (whitelists fields, recomputes reference/tracking number, applies preset fiscal position & pricelist, sets `source`, forces `state='draft'`); `_check_pos_order_lines()` whitelists line fields and re-maps taxes through the fiscal position;
  - `recompute_prices()` + `_compute_line_price()` + `_compute_combo_price()` — authoritative server-side price recomputation (pricelist price, attribute price_extra, combo free/extra distribution — a Python port of `compute_combo_items.js`);
  - notifications: `sync_from_ui`, `remove_from_ui`, `action_pos_order_cancel` all fire `_send_notification` → `config.notify_synchronisation(...)` + `_notify('ORDER_STATE_CHANGED', {})`;
  - receipt e-mail: `_send_self_order_receipt()` (paid/done + email + preset mail template) and `action_send_self_order_receipt()`;
  - `_send_payment_result('Success')` → bus `PAYMENT_STATUS` with serialized order + lines (used by kiosk terminal payments);
  - `_load_pos_self_data_fields` — order fields exposed to the client (incl. `access_token`, `uuid`, `tracking_number`, `table_stand_number`, `self_ordering_table_id`, `source`, ...).
- **pos.order.line**: new `combo_id` (M2o product.combo "Combo reference"); create/write translate `combo_parent_uuid` → `combo_parent_id`.
- **restaurant.table**: `identifier` (Char, uuid hex[:8], required) + `_update_identifier()`; self-data fields: `table_number`, `identifier`, `floor_id`.
- **restaurant.floor**: self-data fields `name`, `table_ids`, domain = config floors.
- **product.template**:
  - `self_order_available` (Boolean, default True, "Available in Self Order") — forced False when `available_in_pos` unset (onchange + write);
  - `self_order_visible` (computed; true iff any config has self-ordering enabled — controls backend UI visibility);
  - `_load_pos_self_data_domain` adds `('self_order_available','=',True)`; `_load_pos_self_data_read` also pulls combo item products not otherwise loaded and reduces `image_128` to a boolean flag;
  - write on `self_order_available` → `_send_availability_status()` on each variant → bus `PRODUCT_CHANGED` with the freshly serialized product payload to every active self-order config (live menu updates);
  - `_can_return_content` override — makes `image_512`/`image_128` publicly downloadable when self_order_available (menu images without auth).
- **product.product**: `_filter_applicable_attributes`, same `_send_availability_status` on write, public `image_512`.
- **pos.category**: `pos_config_ids` M2m (linked configs), public images. (Base `pos.category` already has `hour_after`/`hour_until` availability-window floats used by the self app.)
- **product.tag**: publicly readable image when `visible_to_customers`; self-data domain filters on that flag.
- **pos.preset** (base model in point_of_sale; extended here):
  - `available_in_self` (Boolean), `service_at` (Selection counter/table/delivery), `mail_template_id` (M2o mail.template, model pos.order);
  - self-data domain: default preset OR (available_in_self AND in config.available_preset_ids);
  - `data/preset_data.xml` flags the stock Dine-in/Takeout/Delivery presets for self with images and confirmation-mail templates (`data/mail_template_data.xml`: `takeout_email_template`, `delivery_email_template`).
  - Base preset fields relevant to migration: `pricelist_id`, `fiscal_position_id`, `identification` (none/address/name), `use_timing`, `resource_calendar_id`+`attendance_ids`, `slots_per_interval`, `interval_time` (time-slot booking engine, `get_available_slots()`).
- **pos.session**: self-data fields `id,user_id,config_id,payment_method_ids,state`, domain = opened session of config; adds `_self_ordering` flag into normal POS load (true if any kiosk/mobile config in company) and loads `mail.template` model into the cashier POS.
- **pos.payment.method**: stub `_payment_request_from_kiosk(order)` (implemented by terminal modules) and self-data domain `[('id','=',False)]` (nothing by default — the glue module opens it up).
- **pos.load.mixin** extension: parallel API `_load_pos_self_data_search_read / _load_pos_self_data_domain / _load_pos_self_data_read / _load_pos_self_data_fields` (defaults delegate to the normal `_load_pos_data_*`) — this is *the* pattern to replicate: every model can define what the anonymous self-order client may see.
- **res.partner**: self-load returns nothing by default; read whitelist `id,name,write_date,property_product_pricelist`.
- **res.country**: adds `state_ids` to self fields. **mail.template**: loaded (ids only) for presets.
- **ir.http**: registers frontend translations for the module; `get_nearest_lang` override so website language settings don't override kiosk languages on `/pos-self/...` paths.

### 2.3 Combos
No new combo models — base `product.combo` (`base_price`, `qty_free`, `qty_max`, `combo_item_ids`) and `product.combo.item` (`product_id`, `extra_price`, `combo_id`) are loaded into the self app. Self-order additions are: `pos.order.line.combo_id`, `combo_parent_uuid` handling, and the server-side `_compute_combo_price()` pricing port (free-quota lines share the parent's list price proportionally to combo `base_price`, extra lines add `base_price` + attribute `price_extra` + item `extra_price`, with rounding remainder pushed to the last line).

---

## 3. Customer-facing flow

### 3.1 Boot
1. `GET /pos-self/<config_id>[?access_token&table_identifier]` → QWeb `pos_self_order.index` (bare HTML page, `odoo.access_token`, `session_info` with `config_id` + `self_ordering_mode`, assets bundle `pos_self_order.assets`).
2. App start (`root.js` mounts `selfOrderIndex`); `pos_data` service (patched `PosData`, `services/data_service.js`) fetches:
   - `POST /pos-self/relations/<config_id>` — model fields + relations schema;
   - `POST /pos-self/data/<config_id>` — full dataset via `pos.config.load_self_data()` (all models of §2.2), plus the resolved `access_token`.
3. `SelfOrder` service builds in-memory relational models, categories (`initProducts`: respects `limit_categories`/`iface_available_categ_ids`, excludes special products, adds an "Uncategorised" bucket), languages (cookie `frontend_lang`), kitchen printers; subscribes to bus events; kiosk vs mobile init (`initKioskData`/`initMobileData` — mobile immediately calls `getUserDataFromServer()` to resync its known orders).

### 3.2 Landing page (`pages/landing_page`)
- Image carousel (`self_ordering_image_home_ids`, 5 s auto-advance), brand image/name, language selector popup, custom links (`pos_self_order.custom_link`) rendered as Bootstrap buttons — the "Order Now" one starts the flow, others open external/internal URLs.
- "My Orders" button → cart (if a draft synced order exists) or order-history page.
- `start()`: if presets enabled and >1 → `location` page, else → `product_list`. In pay-after-each mode with an outstanding draft order, ordering again is blocked until it's resolved.
- Kiosk: entering landing wipes all local orders (fresh customer).

### 3.3 Eating-location / preset page (`pages/eating_location_page`)
- Shows `pos.preset` cards (image_512). On mobile without a scanned table, `service_at == 'table'` presets are hidden; kiosk shows all. Selecting sets `order.preset_id` (which drives pricelist, fiscal position, service_at, and required customer info).

### 3.4 Menu / product browsing (`pages/product_list_page`)
- Category rail (top categories; kiosk additionally has a sliding sub-category panel; mobile uses scroll-spy with sticky category pills), scroll shadows, drag-scrolling.
- Category time-windows: `hour_after`/`hour_until` on pos.category filter availability by current time (`getAvailableCategories`).
- Product card: image (`/web/image` on product.template, public because of `_can_return_content`), name, HTML `public_description` (markup'd), price via `getProductDisplayPrice` (pricelist + fiscal position + tax-included flag `iface_tax_included`), qty badge of items already in cart, "fly to cart" animation.
- Tap behavior: combo → `combo_selection` page (skipped if every combo choice is single-item/non-configurable — auto-added); configurable (attributes) → `product` page; else add-to-cart qty 1 directly.
- Product info popup component exists (`components/product_info_popup`) for details.
- Barcode scanning supported (adds scanned product to cart).

### 3.5 Product page / variants (`pages/product_page`, `components/attribute_selection`)
- Qty stepper, customer note, attribute selection: radio/pills/color per attribute display type, multi-select, `is_custom` values with free-text custom values (custom values hidden on kiosk for no_variant attributes), `price_extra` shown per value.
- Variant resolution: `getProductVariantByAttributes` finds the real `product.product` for "always/dynamic" create_variant attributes (its own price/taxes used); `no_variant` attribute values ride on the line as `attribute_value_ids` + `price_extra` (`services/card_utils.js::getOrderLineValues`).
- Missing-required-attribute UX (`shouldShowMissingDetails`, `missing_required_details` component).
- Editing an existing cart line re-opens this page pre-filled (`selfOrder.editedLine`).

### 3.6 Combo page (`pages/combo_page`, `components/combo_stepper`)
- Stepper across combo "choices" (only choices needing interaction: >1 item, qty_max>1, or configurable items), item cards with qty (respecting `qty_max`), free vs extra pricing display (`qty_free` free picks, then `base_price`+extras per additional pick), per-item attribute selection inline, résumé screen, total combo price computed client-side via `computeTotalComboPrice` (temporary transient lines + the shared `computeComboItems` logic).
- Cart lines: parent line (combo product) + child lines with `combo_item_id`, `combo_parent_uuid`/`combo_line_ids` links.

### 3.7 Cart (`pages/cart_page`)
- Lists lines (in pay-after-meal mode only *unsent* lines are shown as "new"), qty edit, note edit, line edit/remove, optional-products upsell (`pos_optional_product_ids`), totals incl. taxes (`orderLineNotSend` computes totals of unsent changes only).
- `pay()` gatekeeping, in order:
  1. `verifyCart()` — removes lines whose product (or combo child product) became `self_order_available = False`, shows `UnavailableProductsDialog`;
  2. required-info check `isValidSelection` (preset `needsSlot` (use_timing) / `needsName` (identification) / `needsEmail` (has mail template) / `needsPartner` (delivery address)) → `PresetInfoPopup` (name, email, phone, address + country/state, time-slot picker; persists partner via `/pos-self-order/validate-partner`; slot availability refreshed via `/pos-self-order/get-slots`);
  3. mobile + table service + no scanned table → `PopupTable` (choose floor/table manually);
  4. then `selfOrder.confirmOrder()`.
- Cancel button (mobile + each + synced order) → `CancelPopup` → `/pos-self-order/remove-order`.

### 3.8 Ordering semantics — new order vs append (`confirmOrder`, `sendDraftOrderToServer`, `currentOrder`)
- The client keeps one "current" draft order (`selectedOrderUuid`; `currentOrder` getter finds/creates it — `createNewOrder()` seeds uuid/ticket_code/preset/pricelist/fiscal position locally).
- `sendDraftOrderToServer()` → `POST /pos-self-order/process-order/<mobile|kiosk>` with `order.serializeForORM()`, config `access_token`, and the **URL** `table_identifier` ("always trust URL one").
- Server side `_get_open_order(order)` matches by `uuid`: same uuid ⇒ **update** the existing draft order (append/modify lines via ORM commands); unknown uuid ⇒ create. Combined with:
  - **pay_after = 'each'**: after a successful send, `selectedOrderUuid = null` ⇒ *next basket is a brand-new order*;
  - **pay_after = 'meal'** (table mode): uuid kept ⇒ subsequent "Order" clicks append to the same draft order; additionally `get-user-data` returns any *other* draft order open on the same table, and the client merges them (`getUserDataFromServer` links foreign draft-order lines into the open order) ⇒ several phones at one table share one order.
- Naming: first save assigns `pos_reference`/`tracking_number` from the config sequence; tracking prefix `K<config>-` (kiosk) or `S` (mobile); `floating_order_name` = "Self-Order T <table_number>" / "Self-Order <tracking>" / kiosk "Table tracker <stand_number>".
- Change tracking: `order.uiState.lineChanges` snapshot per line uuid (qty/note/attributes) → `changes` diff getter decides whether anything new must be sent; `cancelOrder()` rolls lines back to the last synced snapshot.
- Zero-amount orders are set to `paid` immediately server-side and receipt-mailed.

### 3.9 Payment options
- **No payment methods configured** (typical mobile QR at table): order is just sent; confirmation screen shows "pay at cashier" semantics (`screenMode = 'pay'`, or `'order'` for meal-mode intermediate saves). Cashier settles later at the POS.
- **Kiosk payment terminal**: `PaymentPage` → `POST /kiosk/payment/<config_id>/kiosk` with serialized order + `payment_method_id` → server re-runs `process_order`, then `payment_method._payment_request_from_kiosk(order)` (Adyen/Stripe/Razorpay/Pine Labs/Viva.com modules implement it). Async result comes back over the bus as `PAYMENT_STATUS` (`pos.order._send_payment_result`) → success toast → confirmation page (+ receipt print); failure sets `paymentError`.
- **Online payment** (glue module): see §5. Kiosk shows a QR code pointing at the `/pos/pay/...` portal; mobile redirects the browser there.
- Payment-method availability to the self client is controlled server-side by `pos.payment.method._load_pos_self_data_domain`: base = none; glue module = kiosk: terminal PMs + online PMs of the config; mobile: only `self_order_online_payment_method_id`.

### 3.10 Confirmation / status tracking (`pages/confirmation_page`, `pages/order_history_page`)
- Route `/confirmation/{orderAccessToken}/{screenMode}` (screenMode: `order` | `pay`). Looks up the order by access token (fetching from server if unknown), shows tracking number / receipt (OrderReceipt component), optionally downloads receipt PNG (mobile, paid), sends receipt e-mail, prints on kiosk (once — `nb_print` guard + `/pos_self_order/kiosk/increment_nb_print/`), kiosk auto-returns to landing after 30 s and restores default language.
- **Order history** (`/orders`): all locally known orders (persisted in IndexedDB keyed by uuid/access_token), state label ("Current" for draft), line details; draft orders can be re-opened into the cart.
- **Live status updates**: bus `ORDER_STATE_CHANGED` → `getUserDataFromServer()` → `POST /pos-self-order/get-user-data` with `[{access_token, write_date, state}]` of known orders (+ table identifier) → server returns changed orders (and, in meal mode, other draft orders on the table); deleted-on-server orders trigger a `REMOVE_ORDERS` bus push with `deleted_order_tokens` and local cascade-delete. So "status screen" = order history/confirmation pages kept fresh by bus + delta RPC (states draft → paid/done/cancel).
- Kiosk stand-number page (`stand_number_page`, Numpad) collects the table-tracker number before confirming when kiosk + table service.

---

## 4. How self-orders reach the main POS

### 4.1 HTTP endpoints (all `auth="public"`)
`controllers/self_entry.py`:
| Route | Type | Purpose |
|---|---|---|
| `GET /pos-self/<config_id>` (+ `/<path:subpath>`) | http | render SPA (any client route deep-link) |
| `POST /pos-self/data/<config_id>` | jsonrpc | full dataset (`load_self_data`) |
| `POST /pos-self/relations/<config_id>` | jsonrpc | model schema (`load_data_params`) |

`controllers/orders.py`:
| Route | Purpose |
|---|---|
| `POST /pos-self-order/process-order/<device_type>` | create/update draft order; sanitize (`_check_pos_order`) → `sync_from_ui` → `recompute_prices` (anti-tamper) → state draft (or paid if 0); returns serialized order/lines/payments |
| `POST /pos-self-order/validate-partner` | create or reuse res.partner for delivery/contact info |
| `POST /pos-self-order/remove-order` | cancel own draft order (needs order `access_token`, consteq) |
| `POST /pos-self-order/get-user-data` | delta sync of customer's orders (+ table's draft orders in meal mode); pushes `REMOVE_ORDERS` for vanished ones |
| `POST /kiosk/payment/<config_id>/<device_type>` | save order then trigger payment-terminal request |
| `POST /pos_self_order/kiosk/increment_nb_print/` | mark receipt printed |
| `POST /pos-self-order/change-printer-status` | update `has_paper` |
| `POST /pos-self-order/get-slots` | preset time-slot availability |
| `POST /pos-self/ping` | connectivity check (used by connection-lost popup) |

Security model: every RPC requires the config `access_token`; `_verify_pos_config` finds the config sudo, then **drops sudo** and runs as `self_ordering_default_user_id` with the config's company (`sudo(False).with_company(...).with_user(...)`). Table writes require a valid `table_identifier` unless kiosk/takeaway. Order-level ops additionally require the per-order `access_token` (constant-time compare).

### 4.2 Bus / websocket
- Channel: the config's **bus** `access_token` (pos.bus.mixin). `pos.config._notify(name, payload)` sends `bus.bus._sendone(access_token, f"{access_token}-{name}", message)`; clients subscribe via `data.connectWebSocket(NAME, handler)` (`getOnNotified(bus, odoo.access_token)`).
- Events **to the self-order client**: `ORDER_STATE_CHANGED` (resync), `PRODUCT_CHANGED` (live availability/menu updates), `REMOVE_ORDERS`, `STATUS` (kiosk open/closed), `PAYMENT_STATUS` (terminal result), `ONLINE_PAYMENT_STATUS` (glue module: progress/success/fail + serialized order/payments).
- Events **to the cashier POS**: `SYNCHRONISATION` (from `pos.config.notify_synchronisation` — fired by `pos.order.sync_from_ui/remove_from_ui/cancel`, causes the POS to pull new/changed orders; also relayed to `trusted_config_ids`), `ONLINE_PAYMENTS_NOTIFICATION` (pos_online_payment: order id only → POS re-fetches payment state via RPC), `ONLINE_PAYMENT_STATUS` (glue: cashier POS auto-prints the prep ticket + receipt on success — `overrides/services/pos_store.js`, with a visibility-state print queue and `get_order_to_print` row-lock/nb_print guard against double printing).
- Cashier-side integration: self orders are plain draft `pos.order` records in the session, so they appear via the normal order sync; extras are `getServerOrdersDomain` (kiosk drafts), `RestaurantTable.getOrders()` including `self_ordering_table_id` matches (order shows on the scanned table even before a cashier assigns `table_id`), TicketScreen status labels ("Ongoing"/Paid/Cancelled for `Self` references) and table tag from `self_ordering_table_id`.

### 4.3 Token/uuid handling summary
- `pos.order.uuid` (client-generated) = idempotency/merge key (`_get_open_order` by uuid).
- `pos.order.access_token` (server uuid4) = customer's capability to read/cancel/pay that order.
- `pos.config.access_token` = app entry token + bus channel.
- `restaurant.table.identifier` = table capability token in QR.
- Line-level `uuid` + `combo_parent_uuid` for line identity across syncs.

---

## 5. pos_online_payment (+ glue module)

### 5.1 Payment method flag & provider link (`models/pos_payment_method.py`)
- `is_online_payment` (Boolean) — marks a POS payment method as "online".
- `online_payment_provider_ids` (M2m `payment.provider`, domain published & enabled/test). Empty ⇒ *all* published providers. `_get_online_payment_providers(pos_config_id)` filters by journal currency == config currency (ValidationError otherwise).
- `has_an_online_payment_provider` (computed), `type` selection_add `('online','Online')` (auto-computed for online PMs).
- Constraints: max **one** online PM per pos.config (both on method `config_ids` and on `pos.config.payment_method_ids`); online PMs force-clear `split_transactions`, accounts, `journal_id`, `is_cash_count`, `use_payment_terminal`, `qr_code_method`, `payment_method_type='none'`.
- `_get_or_create_online_payment_method(company_id, pos_config_id)` — lazy singleton per company.
- `_get_customer_required_providers_code()` = `['aps','flutterwave']` → `_customer_required` flag in POS data (those need a partner email).

### 5.2 Order / payment / transaction models
- `pos.order`: `online_payment_method_id` (computed from config), `next_online_payment_amount` (Float, the amount the customer's payment page must charge), `get_amount_unpaid()` (rounding-aware), `get_and_set_online_payments_data()` (RPC used by the cashier POS: returns done online payments + unpaid amount, sets next amount, may delete an abandoned draft order), `_process_order` strips online payment lines from draft syncs (online lines are only ever created server-side from transactions).
- `pos.payment`: `online_account_payment_id` (M2o account.payment, one2one) — create/write guards make online payment lines immutable and always backed by an accounting payment.
- `account.payment`: `pos_order_id` M2o.
- `payment.transaction`: `pos_order_id` M2o; `_compute_reference_prefix` uses `pos_reference`; `_post_process` → `_process_pos_online_payment()`: for authorized/done tx → ensure `payment_id`, then `pos_order.add_payment({amount, payment_date, payment_method_id: online PM, online_account_payment_id})`, backlink the account.payment, and if the draft order is now fully paid → `_process_saved_order(False)` (order → paid, accounting flow); finally bus `ONLINE_PAYMENTS_NOTIFICATION {'id': order_id}` (id only — bus is not treated as trusted).
- `pos.session` closing: aggregates `type == 'online'` payments as split receivables per payment, creates per-payment receivable move lines named "session - method (provider)", reconciles them against the account.payment receivable lines.

### 5.3 Payment portal (`controllers/payment_portal.py`)
- `GET /pos/pay/<order_id>?access_token=<order.access_token>[&exit_route=]` — public payment page (template `pos_online_payment.pay`): checks portal access token on pos.order, session must be open, resolves partner (order partner or public user; login redirect if none), amount = `next_online_payment_amount` if set/valid else full unpaid amount, provider/payment-method/token widgets from the `payment` module.
- `POST /pos/pay/transaction/<order_id>` — creates the `payment.transaction` (flow redirect/direct/token; forbids validation payments, tokenization for anonymous users, amount/currency tampering; `custom_create_values.pos_order_id` links the tx).
- `GET /pos/pay/confirmation/<order_id>?tx_id=` — landing route; re-runs `_process_pos_online_payment()`, renders `pos_online_payment.pay_confirmation` or redirects to `exit_route`.

### 5.4 Cashier POS frontend (pos_online_payment)
- PaymentScreen: choosing an online PM first syncs the draft order to the server (needed for a server id + access token). `OrderPaymentValidation` patch: on validate, for each pending online payment line → `updateOnlinePaymentsDataWithServer(order, amount)` (RPC `get_and_set_online_payments_data`) → show `OnlinePaymentPopup` with a **QR code** of the `/pos/pay/...` URL (customer scans and pays on their phone); resolution via `ONLINE_PAYMENTS_NOTIFICATION` bus → re-check with server; validation completes when server says paid. Also mirrored on the customer display.

### 5.5 pos_online_payment_self_order (glue)
- `pos.config.self_order_online_payment_method_id` (M2o, domain is_online_payment) — the online PM for mobile self-order (settings field `pos_self_order_online_payment_method_id`); added to `_load_pos_self_data_fields`.
- `pos.payment.method._load_pos_self_data_domain` override (see §3.9).
- `pos.order.use_self_order_online_payment` (Boolean, computed/stored; guarded `write`) — whether this order follows the self-order online-payment flow vs the cashier QR flow; `_compute_online_payment_method_id` returns the self PM when set. `get_and_set_online_payments_data` flips it back when the cashier cancels their QR flow.
- `pos.order._send_notification_online_payment_status(status)` → bus `ONLINE_PAYMENT_STATUS {status: progress|success|fail, data: {pos.order, pos.payment}}`; `get_order_to_print()` (`FOR UPDATE NOWAIT` + nb_print) for exactly-once cashier printing.
- Controller override: opening `/pos/pay/...` notifies `progress`; failed confirmation notifies `fail`; `payment.transaction._process_pos_online_payment` override notifies `success` + sends the receipt e-mail (and `_process` triggers the payment post-processing cron immediately for self orders so confirmation isn't delayed ~10 min).
- Self-app frontend:
  - `PaymentPage` patch: if selected PM is online → save draft order, then **kiosk**: render QR (`generateQRCodeDataUrl`) of `getOnlinePaymentUrl(order, false)`; **mobile**: `window.open(url, '_self')` with `exit_route` back into the self app (`/pos-self/<id>/confirmation/<order_token>/order?access_token=...&table_identifier=...` in each mode);
  - `SelfOrder` patch: `ONLINE_PAYMENT_STATUS` listener (updates order data, sets `paymentError` on fail, navigates to confirmation on success), `filterPaymentMethods` (adds online PMs), `shouldUpdateLastOrderChange` returns false for mobile+online+each (prep ticket is printed by the POS only after payment succeeds);
  - `OrderDisplay.buttonToShow` patch: Order / Pay / "Pay at cashier" label logic per mode.

---

## 6. Frontend structure of the self-order OWL app

Separate OWL SPA (not the backend webclient): bundle `pos_self_order.assets` built on `point_of_sale.base_app` + selected point_of_sale components (loader, numpad, product card, order display, orderline, receipt, printer stack, related-models/data service). Entry `app/root.js` → `selfOrderIndex` (`app/self_order_index.js/.xml`).

### Services (`app/services/`)
- `self_order_service.js` — `SelfOrder` (Reactive) core store: config/session/models, categories, current order & uuid, cart ops, order sync, bus handlers, printers, languages, error handling, price computation helpers. Exposed as `self_order` service / `useSelfOrder()`.
- `self_order_router_service.js` + `app/router.js` — tiny client router: slot-based `<Router>` component with route patterns per page, history API navigation, optional language prefix, `table_identifier` query-param persistence (`addTableIdentifier`/`getTableIdentifier`).
- `data_service.js` — patch of POS `PosData`: loads via `/pos-self/data|relations`, IndexedDB `pos-self-order-<access_token>` (mobile only; kiosk keeps everything in memory), no device identifier.
- `card_utils.js` — order-line value builder, variant resolution, attribute price extras, combo price computation.
- `printer_service.js` — kiosk printing plumbing.
- `data_service_options.js` — DB table config (orders/lines/payments keyed by uuid).

### Pages (router slots → route)
| Slot | Route | Component |
|---|---|---|
| default | `/pos-self/{id}` | `LandingPage` |
| product_list | `/products` | `ProductListPage` |
| product | `/product/{int:id}` | `ProductPage` |
| combo_selection | `/combo-selection/{int:id}` | `ComboPage` |
| cart | `/cart` | `CartPage` |
| payment | `/payment` | `PaymentPage` (kiosk terminal; online-payment patched) |
| confirmation | `/confirmation/{string:orderAccessToken}/{string:screenMode}` | `ConfirmationPage` |
| location | `/location` | `EatingLocationPage` (presets) |
| stand_number | `/stand_number` | `StandNumberPage` (kiosk numpad) |
| orderHistory | `/orders` | `OrdersHistoryPage` |

### Components (`app/components/`)
`attribute_selection` (+helper), `cancel_popup`, `category_list_popup`, `combo_stepper`, `language_popup`, `language_selector`, `loading_overlay`, `missing_required_details`, `network_connectionLost_popup` (ping-based retry), `order_widget` (bottom cart bar; button label patched by online-payment glue), `popup_table` (floor/table picker), `preset_info_popup` (name/email/phone/address/slot form), `printing_failure_popup`, `product_info_popup`, `product_name_widget`, `quantity_widget`, `slots_popup`, `timeout_popup` (kiosk idle), `unavailable_product_dialog`.

### Models & utils
- `app/models/`: patches of POS models — `pos_config.js`, `pos_order.js` (uiState.lineChanges, `changes`/`unsentLines` diffing, `isTakeaway`, serialize email/mobile), `pos_order_line.js` (per-line diff, display price), `pos_preset.js` (`needsEmail`), `restaurant_floor.js` (new Base model).
- `app/utils/`: `category_scrollspy_hook`, `scroll`, `scroll_dnd_hook`, `scroll_shadow_hook`, plus `utils.js` (name formatting, missing-details logic).
- Styling: `primary_variables.scss`, `bootstrap_overridden.scss`, `kiosk_style.js` (injects company primary bg/text colors), `self_order_index.scss`; `touch-device`/`kiosk` body classes.
- Receipt: reuses POS `OrderReceipt`; kitchen prep ticket template `app/store/order_change_receipt_template.xml`.
- Cashier-POS-side assets (in `point_of_sale._assets_pos`): `backend/qr_order_button` (QR-stands client action), overrides for navbar, product screen ("Available in self" badge/toggle via `product_info_popup` override), receipt header, floor screen, ticket screen, `pos_store.js`, `restaurant_table.js`, prep-receipt inherit.

### Migration-relevant behavioral notes
- Prices are recomputed **server-side** on every submission (`recompute_prices`) — client prices are display-only; replicate this in Laravel.
- The whole read-model is a **snapshot + bus-driven deltas** (`PRODUCT_CHANGED`, `ORDER_STATE_CHANGED`, delta RPC `get-user-data` keyed on `access_token` + `write_date`); a Laravel+React port maps naturally to REST bootstrap + WebSocket (e.g. Reverb/Pusher) channels named by config token, with per-order capability tokens.
- Three token tiers (config token, table identifier, order access token) + default-user impersonation are the entire auth model — there is no customer login.
