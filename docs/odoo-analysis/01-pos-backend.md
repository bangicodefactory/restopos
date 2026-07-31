# Odoo 19 `point_of_sale` — Backend Data Model & Server Logic Inventory

Scope: `addons/point_of_sale` — `models/`, `controllers/`, `security/`, `wizard/` (backend only, no JS).
Purpose: feature-parity spec for a Laravel re-implementation.

Legend for field types: `char`, `text`, `bool`, `int`, `float`, `monetary`, `date`, `datetime`, `selection`, `json`, `image/binary`, `m2o` (belongsTo), `o2m` (hasMany), `m2m` (belongsToMany). "computed" = derived, "stored computed" = derived + persisted. Chatter/mail framework fields omitted.

---

## 0. Shared mixins (cross-cutting infrastructure)

### 0.1 `pos.load.mixin` (abstract) — the data-loading contract
Every model whose data reaches the POS client mixes this in. Per model, three overridable hooks:

- `_load_pos_data_domain(data, config)` → search domain limiting which records go to this POS config. Returning `False` = model not loaded via generic search (e.g. `account.move`). `data` is the partially-built response (models load in a defined order and can reference already-loaded models' rows).
- `_load_pos_data_fields(config)` → whitelist of fields serialized to the client (empty list = all fields, used by `pos.config`).
- `_load_pos_data_read(records, config)` → performs `records._filtered_access("read").read(fields, load=False)`; overridable to post-process (inject computed keys prefixed `_`, currency conversion, strip images, etc.).
- `_load_pos_data_search_read(data, config)` = search(domain) + read; applies **incremental sync**: if context `pos_last_server_date` is set (client passes the date of its last sync) the domain is AND-ed with `('write_date', '>', last_server_date)` for all models except `pos.session`, `pos.config`, `res.users` (`_server_date_to_domain` / `_last_server_date_to_load`). `product.pricelist.item` overrides this to also pick up items whose `date_start` became active since last sync.
- `_unrelevant_records(config)` → ids the client should drop locally (inactive or no longer readable). Used by `pos.session.filter_local_data`.
- `_convert_pos_data_currency(records, config, price_field, currency_field)` → converts prices to the POS currency when record currency differs (used for product `list_price`/`lst_price` and `standard_price`).

### 0.2 `pos.bus.mixin` (abstract) — realtime notifications
- Field: `access_token` char (uuid4, generated at create via `_ensure_access_token`).
- `_notify(name, message)` publishes on Odoo's websocket bus channel `access_token`, event name `"{access_token}-{name}"`. Used for events: `SYNCHRONISATION` (order pushed by another device), `CLOSING_SESSION`, `UPDATE_CUSTOMER_DISPLAY-{device_uuid}`.
- Mixed into `pos.config`, `pos.session`, `pos.order`.
- Laravel equivalent: broadcast channel keyed by config/session token (Pusher/WebSockets/SSE).

---

## 1. Model inventory

### 1.1 `pos.config` — Point of Sale terminal configuration
Inherits `pos.bus.mixin`, `pos.load.mixin`. One record per POS terminal/register.

**Identification / infra**
| Field | Type | Notes |
|---|---|---|
| `name` | char, required | internal POS name |
| `company_id` | m2o `res.company`, required | |
| `active` | bool (default true) | archiving |
| `uuid` | char, default uuid4, copy=False | globally unique id to prevent client-data conflicts |
| `access_token` | char, default 16-hex | public token (customer display, portal) |
| `currency_id` | m2o `res.currency`, stored computed | journal currency, else company currency |
| `last_data_change` | datetime, stored computed | bumped when config fields affecting client cache change (`_compute_local_data_integrity`); client compares to decide full reload |

**Journals & accounting**
- `journal_id` m2o `account.journal` (type general/sale; default a `POSS` "Point of Sale" general journal auto-created by `account.journal._ensure_company_account_journal`) — journal of session closing entries and POS invoice payments.
- `invoice_journal_id` m2o `account.journal` (type sale) — journal for customer invoices.
- `rounding_method` m2o `account.cash.rounding`, `cash_rounding` bool, `only_round_cash_method` bool — cash rounding config. Constraint: strategy must be `add_invoice_line`.

**Sequences** (all `ir.sequence`, no_gap, padding 6, created per config in `create()` via `_create_sequences`, deleted with config):
- `order_seq_id` (all orders — used to build display `name`), `order_backend_seq_id` (order refs `pos_reference`), `order_line_seq_id` (line names), `device_seq_id` (device identifiers, padding 0).
- `_get_next_order_refs(device_identifier)` → `pos_reference = "{YY}{device}-{config_id}-{seq}"` and `tracking_number = seq % 1000`.
- `register_new_device_identifier()` → next device sequence for a new client device.

**Sessions (computed helpers)**: `session_ids` o2m `pos.session`; `current_session_id`/`current_session_state`/`has_active_session`/`number_of_rescue_session` (computed: first non-closed non-rescue session); `last_session_closing_cash`, `last_session_closing_date`; `pos_session_username/state/duration`, `current_user_id`; `statistics_for_current_session` json (paid/draft order counts & totals, opening cash — dashboard).

**Catalog & pricing**
- `pricelist_id` m2o `product.pricelist` (default), `available_pricelist_ids` m2m, `use_pricelist` bool. Constraints: default pricelist ∈ available; all pricelists in POS currency; pricelist company = config company or none.
- `limit_categories` bool + `iface_available_categ_ids` m2m `pos.category` — restrict product catalog.
- `iface_tax_included` selection subtotal/total (price display).
- `tax_regime_selection` bool, `fiscal_position_ids` m2m, `default_fiscal_position_id` m2o `account.fiscal.position`.
- `iface_tipproduct` bool + `tip_product_id` m2o `product.product` (default TIPS product).
- `default_bill_ids` m2m `pos.bill` (opening cash-count denominations).
- `note_ids` m2m `pos.note` (predefined order notes).
- `use_presets` bool, `default_preset_id` / `available_preset_ids` (`pos.preset`).
- `show_product_images`, `show_category_images` bool.

**Payments**
- `payment_method_ids` m2m `pos.payment.method` (default: existing non-cash PMs + one free cash PM, else auto-created Cash/Card/Customer Account trio via `_create_journal_and_payment_methods`).
- Constraints: PMs belong to config company; PM journal currency = config currency; a cash PM (cash journal) can only be used by one config and one journal per cash PM; loss+profit accounts required on cash journal when cash control on.
- `cash_control` bool computed = any PM `is_cash_count`.
- `set_maximum_difference` bool + `amount_authorized_diff` float — max allowed cash-count difference at closing for non-managers.
- `auto_validate_terminal_payment` bool. `use_fast_payment` bool + `fast_payment_method_ids` m2m (stored computed, subset of payment_method_ids).

**Stock**
- `picking_type_id` m2o `stock.picking.type` (outgoing, required, restrict), `warehouse_id` m2o stored computed from picking type, `route_id` m2o `stock.route` (ship-later route), `ship_later` bool, `picking_policy` selection direct/one.

**Hardware / UI flags**: `printer_ids` m2m `pos.printer`, `is_order_printer` bool, `iface_cashdrawer`, `iface_electronic_scale`, `iface_print_via_proxy`, `iface_scan_via_proxy`, `iface_big_scrollbars`, `iface_group_by_categ`, `iface_print_auto`, `iface_print_skip_screen`, `proxy_ip` char, `other_devices` bool, `is_posbox` bool, `epson_printer_ip` char (auto-formatted to Epson certified domain from serial), `customer_display_bg_img` image + name.

**Receipts**: `receipt_header`/`receipt_footer` text (only admins may edit — `_check_header_footer` raises AccessError otherwise), `is_header_or_footer` bool, `basic_receipt` bool (price-less ticket).

**Behavioral flags**: `restrict_price_control` (only managers change prices), `is_margins_costs_accessible_to_every_user`, `manual_discount` (line discounts), `is_closing_entry_by_product` (closing entry broken down per product), `order_edit_tracking` (audit trail of edited/deleted lines), `fallback_nomenclature_id` m2o `barcode.nomenclature` (secondary barcode nomenclature; primary comes from company).

**Module-installer booleans** (`module_pos_restaurant`, `module_pos_hr`, `module_pos_discount`, `module_pos_avatax`, `module_pos_appointment`, `module_pos_sms`): writing true triggers module install (`_check_modules_to_install`). For Laravel: feature flags.

**Trust / cross-register sharing**: `trusted_config_ids` m2m self — configs sharing open orders (must share currency). `_add_trusted_config_id`/`_remove_trusted_config_id`.

**Groups passthrough**: `group_pos_manager_id`, `group_pos_user_id` m2o `res.groups` (to tell client the role group ids).

**Key business methods**
- `open_ui()` — validates config (`_check_before_creating_new_session`: chart of accounts exists, pricelists ok, PM company/currency ok, cash journal has profit/loss accounts, ≥1 payment method, fiscal country set), creates a `pos.session` if none open, returns URL `/pos/ui/<id>`.
- `notify_synchronisation(session_id, device_identifier, records)` — bus-broadcasts changed records (re-read with `_load_pos_data_read`) to all devices of this config and its trusted configs.
- `read_config_open_orders(domain, record_ids)` — client polling/recovery: returns `dynamic_records` (fresh reads of open orders + related models) and `deleted_record_ids` (records that vanished or were cancelled server-side).
- `get_limited_product_count()` / `_get_limited_partner_count()` — loading limits from `ir.config_parameter` `point_of_sale.limited_product_count` (default 5000) / `limited_customer_count` (default 100).
- `get_limited_partners_loading(offset)` — raw SQL: partners ordered by POS order count desc, name; limit/offset (chooses *which* customers preload).
- `get_product_loading_info()` — total matching products vs limit (warn before full sync).
- Forbidden while a session is open (`_get_forbidden_change_fields`): `module_pos_restaurant`, `payment_method_ids`, deactivation (`active`→False).
- `write()` extra logic: settings-view x2many preprocessing, keep-new-vals diffing, fiscal position auto-sync (`_set_fiscal_position`), preset default auto-added to available.
- `update_customer_display(order, device_uuid)` — pushes cart to the customer-facing display via bus.
- `_get_special_products()` — the TIPS product (excluded from normal flows).
- Onboarding scenario loaders (clothes/bakery/furniture/retail demo data) — skippable for migration.
- `_load_pos_data_read` override injects client-only keys: `_server_version`, `_base_url`, `_data_server_date` (server clock at load — baseline for incremental sync), `_has_cash_move_perm`, `_has_cash_delete_perm`, `_pos_special_products_ids`, `_product_default_values` (defaults for formula taxes), `_IS_VAT` (company in EU), and blanks `pricelist_id` if `use_pricelist` false. Loads **all** fields (no field whitelist).

### 1.2 `pos.session` — a cashier work period on one register
Inherits mail.thread, mail.activity.mixin, `pos.bus.mixin`, `pos.load.mixin`.

**Fields**
| Field | Type | Notes |
|---|---|---|
| `config_id` | m2o `pos.config`, required, indexed | |
| `company_id` | related config.company_id | |
| `name` | char, default '/' | assigned from `pos.session` ir.sequence at opening control |
| `user_id` | m2o `res.users`, required, ondelete restrict | "Opened By" |
| `currency_id` | related config.currency_id | |
| `start_at` / `stop_at` | datetime | opening/closing timestamps |
| `state` | selection: `opening_control` → `opened` → `closing_control` → `closed`; default opening_control, indexed | |
| `opening_notes` / `closing_notes` | text | |
| `cash_control` | bool computed | config.cash_control and a cash journal exists |
| `cash_journal_id` | m2o `account.journal`, stored computed | journal of first cash PM |
| `cash_register_balance_start` | monetary | opening float (copied from previous session's real end) |
| `cash_register_balance_end_real` | monetary | counted cash at closing |
| `cash_register_balance_end` | monetary computed | theoretical: start + cash in/out + cash payments |
| `cash_register_difference` | monetary computed | real − theoretical |
| `cash_real_transaction` | monetary | sum of manual cash in/out statement lines (frozen at close) |
| `order_ids` | o2m `pos.order` | |
| `order_count` | int computed | |
| `statement_line_ids` | o2m `account.bank.statement.line` (`pos_session_id`) | manual cash in/out lines |
| `picking_ids` | o2m `stock.picking`; `picking_count`, `failed_pickings` computed | |
| `rescue` | bool | auto-created recovery session for orphan orders; exempt from single-open-session constraint |
| `move_id` | m2o `account.move` | the session closing journal entry |
| `payment_method_ids` | m2m related config.payment_method_ids | |
| `total_payments_amount` | float computed | sum of captured payments |
| `is_in_company_currency` | bool computed | |
| `update_stock_at_closing` | bool | copied at create from company setting `point_of_sale_update_stock_quantities == 'closing'` |
| `bank_payment_ids` | o2m `account.payment` (`pos_session_id`) | aggregated/split bank payments made at closing |

**Constraints**
- `_check_pos_config`: only one non-closed non-rescue session per config.
- `_check_start_date`: session start must not violate accounting lock dates.
- `create()` requires a config; auto-runs `action_pos_session_open`; created sudo when user is POS user.
- Company lock-date validation refuses locking periods with open sessions (`res.company.validate_lock_dates`).

**Lifecycle methods** — see §4 for the full flow. Highlights:
- `action_pos_session_open()` — copies previous session's counted cash into `cash_register_balance_start` when cash control on.
- `set_opening_control(cashbox_value, notes)` — state→opened, `start_at`=now, posts opening-cash difference message, sets counted opening cash; assigns `name` from sequence.
- `try_cash_in_out(type, amount, reason, partner_id, extras)` — creates `account.bank.statement.line` (± amount) on the cash journal; permission `_has_cash_move_permission` (POS manager OR account invoicing group).
- `delete_cash_in_out(absl_id, partner_id)` — deletes a cash move; permission `_has_cash_delete_permission` (POS manager OR account basic group); logs message.
- `get_cash_in_out_list()` — labeled list of cash moves for the closing popup.
- `get_closing_control_data()` — expected cash breakdown (opening + cash payments + moves), per-non-cash-PM totals/counts, `is_manager`, `amount_authorized_diff`.
- `post_closing_cash_details(counted_cash)` — stores `cash_register_balance_end_real`.
- `update_closing_control_state_session(notes)` — state→closing_control, stop_at, closing notes; posts closing difference message.
- `close_session_from_ui(bank_payment_method_diff_pairs)` — full closing from client (see §4).
- `action_pos_session_closing_control` / `action_pos_session_close` / `_validate_session` — the closing pipeline creating the accounting entry.
- `load_data(models_to_load)` / `load_data_params()` / `filter_local_data(models)` — client bootstrap (see §2).
- `get_pos_ui_product_pricelist_item_by_product(...)` — on-demand pricelist item fetch for lazily-loaded products.
- `delete_opening_control_session()` — cancel a never-opened session (no orders).
- `_alert_old_session()` (cron via stock scheduler) — schedules an activity on sessions open > 7 days.
- `log_partner_message` — audit log entries (cash drawer opened, action cancelled, cash move deleted).
- `write()` broadcasts `CLOSING_SESSION` bus event when state becomes closed.
- Loaded client fields: `id, name, user_id, config_id, start_at, stop_at, payment_method_ids, state, update_stock_at_closing, cash_register_balance_start, access_token`.

### 1.3 `pos.order`
Inherits portal.mixin, `pos.bus.mixin`, `pos.load.mixin`, mail.thread. Order `_order = date_order desc, name desc, id desc`.

**Fields**
| Field | Type | Notes |
|---|---|---|
| `name` | char required, default '/' | display ref, e.g. "Shop - 00042"; set when order becomes paid (`_compute_order_name`; refunds: "<orig> REFUND") |
| `uuid` | char, default uuid4 | **UNIQUE constraint** — idempotency key for client sync |
| `pos_reference` | char, indexed | receipt number "YY{device}-{config}-{seq}" |
| `tracking_number` | char | short customer-facing number (seq % 1000) |
| `sequence_number` | int | session-scoped sequence (negative if client-generated) |
| `ticket_code` | char | 5-char alphanumeric code for portal invoice self-service |
| `access_token` | char (portal + bus mixins) | portal access |
| `date_order` | datetime, indexed, default now | server overrides with now() for the currently-processed order |
| `user_id` | m2o `res.users`, default current | cashier |
| `session_id` | m2o `pos.session`, indexed | |
| `config_id` | m2o `pos.config`, stored computed from session | |
| `company_id` | m2o required, indexed | |
| `currency_id` | related config.currency_id | |
| `currency_rate` | float stored computed | company→order currency rate at order date |
| `partner_id` | m2o `res.partner`, indexed | customer |
| `email` / `mobile` | char stored computed from partner (editable) | receipt sending |
| `pricelist_id` | m2o `product.pricelist` | |
| `fiscal_position_id` | m2o `account.fiscal.position` | |
| `preset_id` | m2o `pos.preset`; `preset_time` datetime | e.g. planned pickup slot |
| `floating_order_name` | char | draft/parked order label |
| `state` | selection draft / cancel / paid / done (Posted), default draft, indexed | |
| `lines` | o2m `pos.order.line` | |
| `payment_ids` | o2m `pos.payment` | |
| `amount_total` / `amount_tax` | monetary, required, readonly | recomputed server-side (`_compute_prices`) via tax engine incl. cash rounding |
| `amount_paid` | monetary required | recomputed = Σ payments (client not trusted) |
| `amount_return` | monetary required | change given (negative payments) |
| `amount_difference` | monetary | paid − total |
| `margin`, `margin_percent` | monetary/float computed | Σ line margins (needs `is_total_cost_computed`) |
| `is_total_cost_computed` | bool computed | all lines costed |
| `is_refund` | bool | |
| `refunded_order_id` | m2o computed | original order (via lines.refunded_orderline_id) |
| `refund_orders_count` | int computed | orders that refunded items of this one |
| `has_refundable_lines` | bool computed | any line qty > refunded_qty |
| `to_invoice` | bool | client asked for an invoice |
| `account_move` | m2o `account.move` | customer invoice |
| `is_invoiced`, `invoice_status` (invoiced/to_invoice) | computed | |
| `reversed_move_ids` | o2m `account.move` (`reversed_pos_order_id`) | reversal entries when invoicing after session close |
| `session_move_id` | related session.move_id | |
| `sale_journal` | related config.journal_id, stored | |
| `picking_ids` | o2m `stock.picking`; `picking_count`, `failed_pickings` computed | |
| `picking_type_id` | related config.picking_type_id | |
| `stock_reference_ids` | m2m `stock.reference` | ship-later procurement grouping |
| `shipping_date` | date | ship-later |
| `is_tipped` bool, `tip_amount` monetary | tip-later support | |
| `nb_print` | int | number of receipt prints; once >0 payments cannot change |
| `general_customer_note`, `internal_note` | text | |
| `last_order_preparation_change` | char (JSON) | last state sent to kitchen printers; merge guarded by `metadata.serverDate` (`_ensure_to_keep_last_preparation_change`) |
| `is_edited` (computed), `has_deleted_line` bool, `order_edit_tracking` related | audit | |
| `available_payment_method_ids` | m2m related config PMs (not stored) | |
| `country_code` | related company fiscal country | |
| `source` | selection [('pos','Point of Sale')], default pos | extended by other modules (self-order, etc.) |

**Constraints & write guards**
- unique `uuid`; unlink only draft/cancel (draft orders cancelled first to notify UIs); once state ∈ paid/done/invoiced it cannot go back to draft; cannot modify payments of a printed order; paid amount must cover total (over-payment logged, under-payment error); payment changes are logged to chatter (`_create_pm_change_log`).
- Line deletes / qty decreases logged to chatter when `order_edit_tracking` (sets `is_edited`/`has_deleted_line`).

**Business methods (server logic to port)**
- `sync_from_ui(orders)` — the order sync entry point (see §3).
- `_process_order(order_dict, existing_order)` — create-or-update logic incl. line/payment uuid dedup, session re-assignment, `relations_uuid_mapping` resolution (see §3).
- `_process_payment_lines` — recompute amount_paid; add cash "return" (change) payment when needed.
- `action_pos_order_paid()` — verifies fully paid (with cash-rounding tolerance: HALF-UP → ±rounding/2, else ±rounding); state→paid.
- `_process_saved_order(draft)` — for non-draft: mark paid, create picking, compute costs; if `to_invoice` generate invoice (requires `invoice_journal_id`).
- Refunds: `refund()` / `_refund()` — copy order into current session with `is_refund=True`, negative quantities `-(qty - refunded_qty)` per line, link `refunded_orderline_id`, copy lots. `_is_pos_order_paid()` treats full refund as refunding originally-paid amount. Sync guard: a refund may only reference one original order.
- Invoicing: `_prepare_invoice_vals` (move_type out_invoice/out_refund by sign, partner invoice/delivery addresses, partner bank selection `_get_partner_bank_id`, payment terms only for pay-later, cash-rounding line, reversal link when refunding an invoiced order), `_prepare_invoice_lines` (combo parents become section lines; pricelist-percentage discounts and customer notes become note lines; `extra_tax_data` exported), `_create_invoice` (+ cash-rounding difference adjusted into rounding & payment-term lines), `_generate_pos_order_invoice` — locks records, state→done, creates+posts invoice, creates **payment moves** per payment (`pos.payment._create_payment_moves`), reconciles them with the invoice (`_reconcile_invoice_payments`); if the session was already closed also builds a **misc reversal move** (`_create_misc_reversal_move` fed by `_prepare_aml_values_list_per_nature`: product/tax/rounding/stock/payment-term lines, all negated) to back the order out of the closing entry, then reconciles; generates & emails the PDF.
- `action_pos_order_cancel()` — draft→cancel (+ future-preset guard), broadcasts sync.
- `remove_from_ui(server_ids)` — cancel + hard-delete draft orders (client-side deletion of parked orders).
- `search_paid_order_ids(config_id, domain, limit, offset)` — ticket-screen search over paid orders of config + trusted configs (currency-filtered), returns `[(id, last_modified)]` + total count for client cache diffing.
- `read_pos_data(data, config)` — bundle of order + session-related models returned to client after sync: `pos.order`, `pos.payment`, `pos.order.line`, `pos.pack.operation.lot`, `product.attribute.custom.value`, `account.move` (ids/names), empty `pos.session`.
- `read_pos_orders(domain)` / `read_pos_data_uuid(uuid)` — fetch orders for client.
- Receipt email: `action_send_receipt(email, ticket_image, basic_image)` via mail template with jpg/pdf attachments.
- Stock: `_create_order_picking()` (real-time or ship-later via stock rules `_launch_stock_rule_from_pos_order_lines`), `_should_create_picking_real_time()` = not update_stock_at_closing OR (anglo-saxon AND to_invoice).
- Cost/margin: `_compute_total_cost_in_real_time`, `_compute_total_cost_at_session_closing` (fifo/avco lines costed from stock moves at close).
- Client-load domain: draft orders of the config (`state='draft'`, `config_id=config`) — i.e. open/parked orders are restored to the client at startup.

### 1.4 `pos.order.line`
Inherits `pos.load.mixin`. `_rec_name = product_id`.

| Field | Type | Notes |
|---|---|---|
| `order_id` | m2o `pos.order`, required, cascade, indexed | |
| `company_id` | related order.company_id stored | |
| `name` | char required | line ref from config `order_line_seq_id` (fallback global `pos.order.line` sequence) |
| `uuid` | char default uuid4 | **UNIQUE** — line-level idempotency |
| `product_id` | m2o `product.product` required (sale_ok) | |
| `full_product_name` | char | display name incl. attributes |
| `qty` | float, default 1 (Product Unit precision) | |
| `price_unit` | float | |
| `price_extra` | float | attribute price extra |
| `price_type` | selection original/manual/automatic | how the price was set |
| `discount` | float % | |
| `price_subtotal` / `price_subtotal_incl` | monetary required | tax-excl / tax-incl |
| `tax_ids` | m2m `account.tax` | product taxes (pre-fiscal-position) |
| `tax_ids_after_fiscal_position` | m2m computed | fpos.map_tax(tax_ids) |
| `extra_tax_data` | json | tax-engine custom data (round-trips to invoice) |
| `attribute_value_ids` | m2m `product.template.attribute.value` | selected variant attributes (no_variant) |
| `custom_attribute_value_ids` | o2m `product.attribute.custom.value` | free-text attribute values |
| `pack_lot_ids` | o2m `pos.pack.operation.lot` | lot/serial numbers |
| `product_uom_id` | related product uom | |
| `customer_note` | char | |
| `note` | char | internal product note |
| `notice` | char | discount notice |
| `combo_parent_id` | m2o self; `combo_line_ids` o2m self | combo structure |
| `combo_item_id` | m2o `product.combo.item` | |
| `refunded_orderline_id` | m2o self, indexed | if this line refunds another |
| `refund_orderline_ids` | o2m self | lines that refunded this line |
| `refunded_qty` | float computed | −Σ qty of non-cancelled refund lines |
| `total_cost` | float; `is_total_cost_computed` bool | cost (fifo/avco from moves, else standard_price, currency-converted) |
| `margin`, `margin_percent` | computed | subtotal − cost (0 for combos) |
| `is_edited` | bool | audit flag |

Methods: `_prepare_base_line_for_taxes_computation` (bridge into the shared account.tax engine — income account from product/fpos or journal default, refund sign handling, name build incl. lang/product code/description), `_compute_amount_line_all`/onchanges (subtotal computation), `_prepare_refund_data`, `_launch_stock_rule_from_pos_order_lines` (ship-later procurement, creates `stock.reference`, runs stock rules, fixes lots), `get_existing_lots(company, config, product)` (available lots with qty>0 in the POS source location, via stock.quant group-by), `_get_discount_amount`, `isRefund()` (qty*price<0). Unlink guarded (only when order draft/cancel).
Client-loaded fields: qty, attribute values, prices, uuid, order_id, note, price_type, product_id, discount, tax_ids, pack_lot_ids, customer_note, refund links, combo links, extra_tax_data, write_date.

### 1.5 `pos.pack.operation.lot`
Lot/serial per order line. Fields: `pos_order_line_id` m2o (indexed), `order_id` related, `lot_name` char, `product_id` related. Loaded fields: lot_name, pos_order_line_id, write_date. Used to build/reserve stock.move.line lots (`stock.move._add_mls_related_to_order`, `_create_production_lots_for_pos_order` creates missing `stock.lot`s when picking type allows).

### 1.6 `pos.payment`
| Field | Type | Notes |
|---|---|---|
| `pos_order_id` | m2o required, cascade, indexed | |
| `payment_method_id` | m2o `pos.payment.method` required | must be allowed by session config (constraint) |
| `amount` | monetary required | negative = change/refund |
| `payment_date` | datetime required, default now | |
| `name` | char | label (e.g. "return") |
| `uuid` | char default uuid4, **UNIQUE** | |
| `is_change` | bool | change-back payment |
| `currency_id`, `currency_rate`, `partner_id`, `session_id` (stored), `user_id`, `company_id` (stored) | related | |
| Terminal metadata: `card_type`, `card_brand`, `card_no` (last 4), `cardholder_name`, `payment_ref_no`, `payment_method_authcode`, `payment_method_issuer_bank`, `payment_method_payment_mode`, `transaction_id`, `payment_status`, `ticket` | char | |
| `account_move_id` | m2o `account.move` | payment move when order invoiced |

Constraints: cannot edit payment of posted/invoiced order; PM must belong to session config.
Methods: `_create_payment_moves(is_reverse)` — per payment (skipping pay_later and zero amounts; cash change merged into its cash payment) creates a 2-line journal entry on the POS journal: **credit** customer receivable (accounting partner), **debit** POS receivable (or partner receivable/PM receivable when reversing) and posts it; `_get_receivable_lines_for_invoice_reconciliation`.

### 1.7 `pos.payment.method`
| Field | Type | Notes |
|---|---|---|
| `name` | char required, translated | |
| `sequence` | int | ordering |
| `journal_id` | m2o `account.journal` (cash unused-by-other-PM, or bank), restrict, check_company | determines `type` |
| `type` | selection computed: cash / bank / pay_later (no journal) | |
| `is_cash_count` | bool stored computed (type == cash) | |
| `split_transactions` | bool "Identify Customer" | per-customer receivable lines at closing; forces partner |
| `outstanding_account_id` | m2o `account.account` restrict | outstanding account for bank account.payments |
| `receivable_account_id` | m2o `account.account` restrict (reconcilable receivable) | overrides company default POS receivable |
| `config_ids` | m2m `pos.config` | |
| `company_id` | m2o | |
| `active` | bool | |
| `image` | image 50×50 | |
| `use_payment_terminal` | selection (provided by terminal modules) | |
| `payment_method_type` | selection none/terminal/qr_code, required, default none | |
| `qr_code_method` | selection (bank QR methods) | |
| `default_qr` | char computed | pre-generated amount-less QR (offline use) |
| `open_session_ids` | m2m computed | open sessions using it |
| `default_pos_receivable_account_name` | related company default | |

Constraints/guards: write forbidden (except `sequence`) while an open session uses the method; QR methods need bank journal + bank account + method; cash method limited to a single config; configs must be same company; journal type immutable once linked (on `account.journal`); journal archive/delete blocked while PMs exist.
Methods: `get_qr_code(amount, ...)` — builds payment QR base64; `_get_payment_method_type`, `get_provider_status`.
Client fields: id, name, is_cash_count, use_payment_terminal, split_transactions, type, image, sequence, payment_method_type, default_qr. Domain: all incl. archived.

### 1.8 `pos.category`
Order `sequence, name`. Fields: `name` (char required, translated), `parent_id` m2o self (indexed, cycle constraint), `child_ids` o2m, `sequence` int, `image_512`/`image_128` image, `color` int (random default 0-10), `hour_until` / `hour_after` float (availability window 0–24, until ≥ after, for self-order), `has_image` computed. Delete blocked while any session open. `display_name` = slash-joined hierarchy; `_get_descendants()`. Client fields: id, name, parent_id, child_ids, write_date, has_image, color, sequence, hour_until, hour_after. Domain: when `limit_categories`, only `iface_available_categ_ids` + printer categories.

### 1.9 `pos.bill`
Cash denominations. Fields: `name` char, `value` float required (16,4), `pos_config_ids` m2m. `name_create` parses the name as a float. Client domain: bills of the config or global (no config). Fields: id, name, value.

### 1.10 `pos.note`
Predefined order/line notes. Fields: `name` char required **unique**, `sequence` int default 1, `color` int. Client: name, color; domain = config.note_ids.

### 1.11 `pos.printer`
Kitchen/preparation printers. Fields: `name` char required, `printer_type` selection iot/epson_epos (default iot), `proxy_ip` char, `epson_printer_ip` char (required for epson; auto-converted serial→certified domain), `product_categories_ids` m2m `pos.category`, `company_id` m2o required, `pos_config_ids` m2m. Client fields: id, name, proxy_ip, product_categories_ids, printer_type, epson_printer_ip. `use_local_network_access()` reads config param `point_of_sale.use_lna`.

### 1.12 `pos.preset`
Named configuration presets (e.g. Dine-in / Takeaway / Delivery). Fields: `name` char required translated, `pricelist_id` m2o, `fiscal_position_id` m2o, `identification` selection none/address/name (customer info required), `is_return` bool (negative-qty mode), `color` int, `image_512`/`image_128`, `has_image` computed, `count_linked_orders`/`count_linked_config` computed; timing: `use_timing` bool, `resource_calendar_id` m2o `resource.calendar`, `attendance_ids` related o2m `resource.calendar.attendance` (constraint hour_from < hour_to), `slots_per_interval` int default 5, `interval_time` int minutes default 20. Methods: `get_available_slots()` / `_compute_slots_usage()` — slot occupancy from orders with `preset_time` in the last day (state draft/paid, opened session). Delete blocked if linked to a config. Client fields: id, name, pricelist_id, fiscal_position_id, is_return, color, has_image, write_date, identification, use_timing, slots_per_interval, interval_time, attendance_ids.

### 1.13 Product-side extensions
**`product.template`** adds: `available_in_pos` bool (default false; sale_ok coupled via onchanges), `to_weight` bool (scale), `pos_categ_ids` m2m `pos.category`, `public_description` html, `pos_optional_product_ids` m2m self (upsell suggestions), `color` int (stored computed from first pos category), `pos_sequence` int (display order, default max+1).
Guards: cannot delete/archive POS-available products (or the special TIPS product) while any session open; product must leave combos before losing `available_in_pos`.
Loading: domain = company + available_in_pos + sale_ok (+ pos_categ restriction); **limited loading**: raw SQL ordering by is_favorite desc, service-type first, last stock-move date desc, write_date desc, LIMIT `limited_product_count`; always force-load combo children, special/tip products, optional products, and products referenced by loaded order lines. Read post-processing: `image_128` → bool flag, multi-company tax filtering, `_archived_combinations` (attribute exclusions), currency conversion of list/cost price.
On-demand: `load_product_from_pos(config_id, domain, offset, limit)` — returns product bundle (template, variants, combos+items, attributes/lines/values/exclusions, pricelists+items, product.uom barcodes, taxes) — used for barcode misses & lazy loading; `create_product_variant_from_pos`; `get_product_info_pos` (price/tax breakdown, per-pricelist prices, per-warehouse qty, suppliers, variants — product info popup).
Client fields incl.: display_name, standard_price, categ_id, pos_categ_ids, taxes_id, barcode, name, list_price, is_favorite, default_code, to_weight, uom_id, description_sale, description, tracking, type, service_tracking, is_storable, color, pos_sequence, available_in_pos, attribute_line_ids, active, image_128, combo_ids, product_variant_ids, public_description, pos_optional_product_ids, sequence, product_tag_ids, currency ids.

**`product.product`**: no new columns; loading of variants of loaded templates; fields: lst_price, display_name, product_tmpl_id, product_template_(variant_)value_ids, barcode, product_tag_ids, default_code, standard_price, currency ids + tax-engine product fields; prices currency-converted; delete/archive guards mirror template.

**`product.combo`** adds `qty_max` int ≥1 (default 1) and `qty_free` int ≥0 ≤ qty_max (default 1). Client: id, name, combo_item_ids, base_price, qty_free, qty_max. **`product.combo.item`**: id, combo_id, product_id, extra_price.

**Attributes**: `product.attribute` (name, display_type, create_variant), `product.template.attribute.line` (display_name, attribute_id, product_template_value_ids, active), `product.template.attribute.value` (attribute_id, attribute_line_id, product_attribute_value_id, price_extra, name, is_custom, html_color, image, exclude_for; only ptav_active), `product.template.attribute.exclusion` (value_ids, product_template_attribute_value_id), `product.attribute.custom.value` adds `pos_order_line_id` m2o cascade (custom_value, custom_product_template_attribute_value_id, pos_order_line_id, write_date).

**Pricelists**: `product.pricelist` (id, name, display_name, currency_id, item_ids; domain = config's available pricelists + preset pricelists + referenced base pricelists). `product.pricelist.item` — full rule fields for client-side price computation: product_tmpl_id, product_id, pricelist_id, price_surcharge, price_discount, price_round, price_min_margin, price_max_margin, company_id, currency_id, date_start/end, compute_price, fixed_price, percent_price, base_pricelist_id, base, categ_id, min_quantity; domain restricted to loaded products/categories and active date window; special incremental-sync handling for newly-active date ranges.

**Misc product models**: `product.tag` adds `pos_description` html + `has_image` (client: name, pos_description, color, has_image, write_date); `product.category` (id, name, parent_id, removal_strategy_id); `product.uom` (barcode-per-uom packaging: id, barcode, product_id, uom_id); `product.removal` (method); `uom.uom` adds `is_pos_groupable` bool (client: id, name, factor, is_pos_groupable, parent_path, rounding + tax-engine uom fields, incl. archived).

### 1.14 `res.partner` extensions
Adds: `pos_order_count` int computed (group-restricted to POS users), `pos_order_ids` o2m, `pos_contact_address` char computed (address w/o company), `invoice_emails` char computed (own + invoice-child emails), `fiscal_position_id` m2o computed (auto fiscal position for partner). Delete blocked if partner has POS orders (archive instead).
Loading: limited to top-N (default 100) partners by POS order count (raw SQL) + current user's partner + partners of loaded orders. `get_new_partner(config_id, domain, offset)` — paged, on-demand partner fetch (+ their fiscal positions). Client fields: id, name, street, street2, city, state_id, country_id, vat, lang, phone, zip, email, barcode, write_date, property_product_pricelist, parent_name, pos_contact_address, invoice_emails, fiscal_position_id, is_company, property_account_receivable_id. (Client can also create/update partners through standard ORM write access implied by the loading of these fields — no dedicated endpoint in this module.)

### 1.15 `res.users` extensions
Client load: only the current user; fields id, name, partner_id (+ computed `_role` = 'manager' if user in `group_pos_manager` else 'cashier'). Permission helpers: `_has_cash_move_permission` (POS manager OR `account.group_account_invoice`), `_has_cash_delete_permission` (POS manager OR `account.group_account_basic`).

### 1.16 `res.company` extensions
Adds: `point_of_sale_update_stock_quantities` selection real/closing (default real) — drives `pos.session.update_stock_at_closing`; `point_of_sale_use_ticket_qr_code` bool (default true), `point_of_sale_ticket_unique_code` bool (5-digit `ticket_code`), `point_of_sale_ticket_portal_url_display_mode` selection qr_code/url/qr_code_and_url. Lock-date constraint (see 1.2). Client fields incl. currency_id, vat, name, contact data, `tax_calculation_rounding_method`, **`nomenclature_id`** (barcode nomenclature), fiscal country, and the three ticket settings.

### 1.17 Accounting / tax touchpoints
- **`account.tax`** (+load mixin): loaded for the config company; client fields: id, name, price_include, include_base_amount, is_base_affected, has_negative_factor, amount_type, children_tax_ids, amount, company_id, sequence, tax_group_id, fiscal_position_ids → client computes taxes offline with the same engine. Guard: forbidden to modify tax-defining fields (`amount`, `amount_type`, `type_tax_use`, `tax_group_id`, `price_include*`, `include_base_amount`, `is_base_affected`) while any unposted POS order line uses the tax.
- **`account.tax.group`**: id, name, `pos_receipt_label`.
- **`account.fiscal.position`**: id, name, display_name, `tax_map`, tax_ids; loaded for config fiscal positions + presets + loaded partners; archiving clears it from configs.
- **`account.cash.rounding`** (+load mixin): id, name, rounding, rounding_method, strategy; config's method only; cannot change while session open; cannot delete while referenced by a config.
- **`account.journal`**: adds `pos_payment_method_ids` o2m; type change / archive / delete guards; POS PM outstanding accounts registered as valid outstanding payment accounts; `_ensure_company_account_journal` auto-creates 'POSS' general journal.
- **`account.account`** (+load mixin): only partners' receivable accounts; fields id, `non_trade`.
- **`account.bank.statement.line`**: adds `pos_session_id` m2o (cash in/out & closing cash lines).
- **`account.payment`**: adds `pos_payment_method_id` m2o, `force_outstanding_account_id` m2o (overrides computed outstanding account), `pos_session_id` m2o; SEPA CT excluded for POS payments.
- **`account.move`** (+load mixin, not searched generically): adds `pos_order_ids` o2m (inverse of order.account_move), `pos_payment_ids` o2m, `pos_refunded_invoice_ids` m2m self, `reversed_pos_order_id` m2o, `pos_session_ids` o2m, `pos_order_count` computed. Behavior: closing moves always tax-exigible (no cash-basis deferral); anglo-saxon COGS price unit taken from POS pickings; `button_draft` blocked while the POS session is open; storno support for reversal moves; invoice payments widget shows POS payment method name. Client fields: id, name.
- **`decimal.precision`**: all, fields id, name, digits (client rounding).
- **`res.currency`**: company + config + pricelist currencies; fields id, name, symbol, position, rounding, rate, decimal_places, iso_numeric.
- **`res.country`** (id, name, code, vat_label), **`res.country.state`** (id, name, code, country_id), **`res.lang`** (id, name, code, flag_image_url, display_name), **`resource.calendar.attendance`** (id, hour_from, hour_to, dayofweek, day_period — preset slots), **`ir.module.module`** (only `pos_settle_due`: id, name, state — feature detection).

### 1.18 Barcode nomenclature usage
- `barcode.rule.type` extended with POS types: `weight` (weighted product), `price` (price-embedded), `discount`, `client` (customer badge), `cashier` (cashier badge).
- The active nomenclature id is delivered via `session_info['nomenclature_id']` (company) and `session_info['fallback_nomenclature_id']` (config) in the `/pos/ui` page; parsing happens client-side. `pos.config.fallback_nomenclature_id` m2o. Barcode fields exist on product.product, product.template, product.uom (per-packaging barcodes) and res.partner and are loaded to the client for offline scanning; server-side fallback lookup: `pos.session.find_product_by_barcode` / `product.template.load_product_from_pos`.

### 1.19 Stock integration (summary)
- `stock.picking` adds `pos_session_id`, `pos_order_id`; `_create_picking_from_pos_order_lines(dest, lines, picking_type, partner)` creates an outgoing picking for positive-qty consumable lines and a return picking for negative lines, sets done quantities incl. lots, and immediately `_action_done()`s them (failures swallowed → `failed_pickings` flags).
- `stock.picking.type` (+load mixin; config's type only): use_create_lots, use_existing_lots, has_stock_reports_to_print; archive guard while used by a config.
- `stock.warehouse` adds `pos_type_id` m2o picking type (auto-created "PoS Orders" outgoing type per warehouse).
- `stock.move` helpers: `_add_mls_related_to_order` (assign done qty & lots), `_create_production_lots_for_pos_order`, ship-later reference propagation, no confirmation email for POS deliveries.
- `stock.reference` adds `pos_order_ids` m2m (ship-later procurement grouping).

### 1.20 Wizards (transient)
- `pos.close.session.wizard` — force-close with a balancing account when closing entry is imbalanced (fields: amount_to_balance, account_id, account_readonly, message).
- `pos.make.invoice` — batch invoicing of paid orders; `consolidated_billing` groups by (config, partner, user, fiscal position); guards refund-of-invoiced orders; may chain to `pos.confirmation.wizard` (assign the single known customer to partner-less orders).
- `pos.make.payment` — backend payment registration on an order (config_id, amount defaulted to remaining incl. refund logic, payment_method_id, payment_name, payment_date); `check()` adds payment (rounded per config), then `_process_saved_order(False)` when fully paid, notifies clients.
- `pos.details.wizard` / `pos.daily.sales.reports.wizard` — sale-details report (date range / one session).

### 1.21 Misc
- `ir.sequence`: delete guard when used by a pos.config.
- `digest.digest`: `kpi_pos_total` KPI (sum amount_total of non-draft/cancel orders).
- `binary` controller override: public access to `pos.config.customer_display_bg_img` image.
- `res.config.settings` (363 lines): proxies pos.config/company fields into Settings UI (`pos_*` related fields, `update_stock_quantities`, ticket settings, module toggles, `is_kiosk_mode`, barcode nomenclatures...). No standalone business logic worth porting beyond what's on pos.config/res.company.
- `report_sale_details` (`report.point_of_sale.report_saledetails`): aggregates orders of sessions/configs/date-range into the daily sales report: products sold (grouped by category, with discounts), payments per method (incl. cash counted/expected/difference and opening), taxes on sales & refunds, refund detail, invoice list, total, session cash moves. Worth re-implementing as a reporting query.

---

## 2. Data-loading contract (client bootstrap)

Entry: client opens `/pos/ui/<config_id>` (HTTP controller) → rendered page carries `session_info` (+ `pos_session_id`, `pos_config_id`, `access_token`, `last_data_change`, nomenclature ids, urls_to_cache for the service worker/offline cache). Then the client makes ORM RPC calls (standard `call_kw`) on `pos.session`:

1. **`load_data_params()`** → for every model: `{fields: [...], relations: {...}}` where relations metadata (`_load_pos_data_relations`) describes each field's type, comodel, inverse, m2m relation table, compute/related flags — the client builds a mini-ORM from this.
2. **`load_data(models_to_load)`** → `{model_name: [record dicts]}` for the model list below, each via `_load_pos_data_search_read`. Models a user cannot read are returned as `[]` (AccessError swallowed). Passing context `pos_last_server_date` turns this into an **incremental sync** (only write_date > last sync, except session/config/users).
3. **`filter_local_data({model: ids})`** → ids the client must purge (deleted or irrelevant/inactive).

**Models pushed to the client** (`_load_pos_data_models`, in load order — order matters because later domains reference earlier data):
`pos.config`, `pos.preset`, `resource.calendar.attendance`, `pos.order` (draft only), `pos.order.line`, `pos.pack.operation.lot`, `pos.payment`, `pos.payment.method`, `pos.printer`, `pos.category`, `pos.bill`, `res.company`, `product.template`, `product.product`, `product.attribute`, `account.tax`, `account.tax.group`, `product.attribute.custom.value`, `product.template.attribute.line`, `product.template.attribute.value`, `product.template.attribute.exclusion`, `product.combo`, `product.combo.item`, `res.users` (current only), `res.partner` (top-100 by order count), `product.uom`, `decimal.precision`, `uom.uom`, `res.country`, `res.country.state`, `res.lang`, `product.category`, `product.pricelist`, `product.pricelist.item`, `account.cash.rounding`, `account.fiscal.position`, `stock.picking.type`, `res.currency`, `pos.note`, `product.tag`, `ir.module.module`, `account.move`, `account.account`, `product.removal` — plus `pos.session` itself (always first).

**Lazy loading endpoints** (called later on demand): `product.template.load_product_from_pos` (barcode miss / paging), `res.partner.get_new_partner` (customer search paging), `pos.session.get_pos_ui_product_pricelist_item_by_product`, `pos.order.line.get_existing_lots`, `pos.order.search_paid_order_ids` + `read_pos_orders` (ticket screen), `pos.config.read_config_open_orders` (shared open orders / recovery), `product.template.get_product_info_pos` (product info popup).

Limits: products 5000, partners 100 (ir.config_parameter overridable). Special products (TIPS) always loaded.

---

## 3. Order sync flow (client → server)

**Transport**: standard ORM JSON-RPC `call_kw` on `pos.order.sync_from_ui(orders)` (list of order dicts shaped as ORM vals with `lines`/`payment_ids` as ORM commands `[0, 0, vals]` / `[1, id, vals]`). No dedicated REST controller. Context carries `device_identifier` and optionally `current_order_uuid`.

**Idempotency / identity**: every order, line, and payment carries a client-generated `uuid` with a DB unique constraint. Resolution in `sync_from_ui` / `_process_order`:
- `_get_open_order(order)`: lookup by `uuid` (latest id).
- Not found → create (server completes: pricelist/fpos/company/preset defaults, generates `pos_reference` + `tracking_number` + `sequence_number` via config sequences if absent — `_complete_values_from_session`).
- Found and `state == 'draft'` → update: session moved if changed; **line/payment CREATE commands whose uuid already exists on the order are rewritten into UPDATE commands** (offline retry dedup); preparation-change JSON merged by `serverDate` (newer server state wins); `uuid`/`access_token` stripped from vals; a client 'paid' state is deferred (applied by `_process_saved_order`).
- Found and not draft → sync ignored, existing id returned (e.g. tip-later double-send).
- `relations_uuid_mapping` in the payload lets the client link records to other records by uuid instead of server id (resolved post-write).

**Processing per order** (`_process_order` continued):
- Closed-session guard: if the order's session is closed/closing, `_get_valid_session` reroutes it to any open session of the same config, else raises "No open session available" (rescue behaviour for late offline pushes).
- Dangling partner_id (deleted partner) reset to false, `to_invoice` cleared.
- `_process_payment_lines`: `amount_paid` recomputed from payments ("we don't trust the client"); if change due, a negative cash payment `is_change=True` is appended (error if no cash PM).
- `_process_saved_order(draft)`: non-draft → `action_pos_order_paid()` (full-payment check w/ rounding tolerance), `_create_order_picking()`, cost computation; `to_invoice` → `_generate_pos_order_invoice()`.
- Refund guard: all refund lines must reference a single original order.

**Response**: `read_pos_data` bundle (orders + lines + payments + lots + custom attr values + related account.move ids) so the client reconciles server ids/names.

**Fan-out**: after sync, `config.notify_synchronisation(...)` broadcasts over the bus to all devices of the config + trusted configs so other registers see the order.

**Offline recovery**: orders queue client-side (service worker + IndexedDB, `urls_to_cache`); on reconnect they're re-pushed through the same `sync_from_ui` (uuid dedup makes retries safe); `read_config_open_orders` + `deleted_record_ids` reconcile drift; `filter_local_data` purges stale cache; incremental loads via `pos_last_server_date`; per-order logging with a random `sync_token`, optional full-payload logging behind `point_of_sale.log_order_data`.

**Other order endpoints**: `remove_from_ui` (delete parked drafts), `action_pos_order_cancel`, `read_pos_data_uuid`, `pos.config.notify_synchronisation`, customer display push.

---

## 4. Session lifecycle & accounting

**States**: `opening_control` → `opened` → `closing_control` → `closed`.

1. **Create/open**: `pos.config.open_ui` (row-lock on config to prevent duplicate sessions) → `pos.session.create` (one open session per config; `update_stock_at_closing` snapshot) → `action_pos_session_open` (opening balance ← previous session's counted cash). Cashier then calls `set_opening_control(cashbox_value, notes)`: state=opened, start_at=now, opening difference logged to chatter, `cash_register_balance_start` = counted value, session `name` from `pos.session` sequence.
2. **During session**: orders sync (§3); cash in/out via `try_cash_in_out` (bank statement lines on the cash journal, signed) and `delete_cash_in_out`; real-time pickings unless update-at-closing.
3. **Closing from UI**: `get_closing_control_data` (expected amounts) → `post_closing_cash_details(counted_cash)` (stores real end balance) → `update_closing_control_state_session(notes)` (state=closing_control) → `close_session_from_ui(bank_diff_pairs)`:
   - `_cannot_close_session`: no draft orders for the day; not already closed (if closed by someone else → "rescue session" alert); bank-diff journals must have profit/loss accounts.
   - draft orders with a **future preset_time** are detached from the session (kept for later).
   - → `action_pos_session_closing_control` → sets closing_control + stop_at; if no cash control closes directly; rescue sessions auto-compute counted cash → `_validate_session`.
4. **`_validate_session`** (the big one; runs sudo for POS users):
   - `cash_real_transaction` = Σ statement lines; guards: no draft orders (`_check_if_no_draft_orders`), all order invoices posted (`_check_invoices_are_posted`).
   - If `update_stock_at_closing`: `_create_picking_at_end_of_session` — one picking per destination location for all closed non-invoiced/non-ship-later orders; then costs for fifo/avco lines.
   - `_create_account_move` builds the **closing journal entry** on `config.journal_id` (ref = session name) via `_accumulate_amounts` then line builders. If unbalanced → rollback + `pos.close.session.wizard` (manager picks a balancing account, amount posted via `_create_balancing_line`).
   - `_post_statement_difference(cash_difference_before_statements)` — cash over/short posted as a statement line against the cash journal's **profit/loss account** (tax-aware if the counterpart account has taxes) with payment_ref "Cash difference observed during the counting (Profit/Loss)".
   - Post move (or delete if empty); uninvoiced 'paid' orders → 'done'; `_reconcile_account_move_lines`; edited-orders audit message; stock reordering rules triggered; state=closed (broadcasts CLOSING_SESSION); flush.

**Closing entry composition** (`_accumulate_amounts` on non-draft/cancel orders):
- *Uninvoiced orders*: sales lines credited per key (income account, sign, taxes, tax tags, optionally product when `is_closing_entry_by_product` — then also with quantities); tax lines per (account, repartition line, tags) with base amounts; cash-rounding difference accumulated (posted to rounding method's profit/loss account or folded into biggest tax); partner `customer_rank` incremented.
- *Payments*: grouped as combine vs split (per `split_transactions`) × cash/bank/pay_later:
  - **bank combine**: debit receivable line (PM receivable or company `account_default_pos_receivable_account_id`) + an **`account.payment`** on the PM's bank journal (outstanding account forced) posted and reconciled with it; per-PM closing **difference** (`bank_payment_method_diffs`) adjusts the payment move against journal profit/loss accounts.
  - **bank split**: one receivable line + one account.payment **per payment/partner** (partner receivable), reconciled per partner.
  - **cash**: `account.bank.statement.line`s on the cash journal (combine per PM / split per payment with partner) + matching receivable move lines in the closing entry; both posted and reconciled.
  - **pay_later**: receivable move lines only (partner receivable if split, POS receivable if combined), left open for follow-up — no statement/payment.
  - *Invoiced orders*: their revenue/tax already lives on the invoice; the closing entry only gets **credit** lines on the POS receivable ("From invoice payments") which are reconciled against the debit POS-receivable lines of the per-order invoice payment moves (created at invoicing time by `pos.payment._create_payment_moves`).
- *Stock (real-time valuation)*: expense (COGS) debit vs stock valuation credit (returns separated), in company currency.
- Multi-currency: session amounts are in POS currency; every line carries `amount_currency` + converted `balance` (`_update_amounts`, `_credit_amounts`/`_debit_amounts`, `_amount_converter`).

**Related-move traversal**: `_get_related_account_moves` = invoices + invoice payment moves + closing move + stock account moves + cash statement moves + bank payment moves + split-diff/cost moves.

**Rescue sessions**: `rescue=True` sessions collect orders that arrive after their session closed (via `_get_valid_session` any open session is preferred; the "Rescue" concept surfaces when closure raced the client). Rescue sessions bypass the one-open-session constraint, can't be closed from the UI, and auto-derive counted cash.

---

## 5. Access control

**Groups** (`security/point_of_sale_security.xml`):
- `point_of_sale.group_pos_user` ("User") — cashier role.
- `point_of_sale.group_pos_manager` ("Administrator") — implies `group_pos_user` + `stock.group_stock_user`; granted to admin.
- `point_of_sale.group_pos_preset` ("Preset Menu") — feature-gate group for presets.
- Client receives `_role` = manager|cashier on the loaded user record.

**Model ACLs** (ir.model.access.csv, R/W/C/U):
| Model | POS User | POS Manager | Notes |
|---|---|---|---|
| pos.order, pos.order.line, pos.pack.operation.lot, pos.payment | CRUD (no distinct manager row) | — | full for users |
| pos.session | R/W/C (no delete) | — | |
| pos.config | R/W | full CRUD | also base.group_system R/W |
| pos.category | R (all internal users) | full CRUD | |
| pos.payment.method, pos.note, pos.preset, pos.printer | R | full CRUD | |
| pos.bill | full CRUD (user) | — | |
| account.bank.statement.line | R/W/C (no delete) | full CRUD | cash in/out; delete needs manager/accounting |
| product.product / template / supplierinfo / pricelist | R | pricelist full CRUD for manager | |
| stock.picking, stock.move | CRUD (user) | — | POS creates pickings |
| stock.warehouse / location | R | R | |
| account.journal, account.move, account.move.line, account.cash.rounding, decimal.precision, barcode.nomenclature/rule | R (user) | barcode CRUD for manager; payment.method(.line) read for manager | |
| Wizards: details/make.payment/daily.reports manager-only; close.session, make.invoice, confirmation user-accessible | | | |

**Record rules**: multi-company rules on pos.order(.line), pos.session, pos.config, pos.payment(.method), report; POS users see only bank statement lines with `pos_session_id` set, and only account.move(.line) linked to POS orders.

**Functional (code-level) permission gates** to reproduce:
- Cash in/out: POS manager or invoicing group (`_has_cash_move_permission`); delete cash move: POS manager or account-basic (`_has_cash_delete_permission`).
- Closing difference above `amount_authorized_diff` blocked for non-managers when `set_maximum_difference` (client-enforced with server data `is_manager` from `get_closing_control_data`).
- Receipt header/footer edits: admins only.
- `restrict_price_control` / `is_margins_costs_accessible_to_every_user`: manager-only price edits & margin visibility (client-enforced flags).
- Session create/validate runs sudo for POS users (they lack accounting rights); the pattern to port: cashier-triggered postings execute with elevated service credentials.
- Superuser cannot open a POS session (`open_ui` guard).

---

## 6. HTTP controllers

- `GET /pos/ui/<config_id>` (auth user, internal users only) — opens/creates session (with `FOR UPDATE NOWAIT` config lock), renders SPA with session_info (company forced to session company, nomenclature ids, access token, cache manifest, `last_data_change`).
- `GET /pos/service-worker.js` — offline service worker.
- `POST /pos/ping` (jsonrpc) — connectivity check.
- `GET /pos/sale_details_report` — PDF sale details.
- `GET|POST /pos/ticket` (public) — portal form: find an order by receipt number (≥12 chars), date (±1/2 days), and 5-char `ticket_code`; redirects to validation.
- `GET|POST /pos/ticket/validate?access_token=` (public) — self-service invoicing: partner form (+ per-country extra fields), creates/updates partner, calls `action_pos_order_invoice`, redirects to portal invoice.
- `GET /pos_customer_display/<id>/<device_uuid>?access_token=` (public, constant-time token compare) — customer-facing display page; updates streamed over the bus.
- `GET /web/image/pos.config/<id>/customer_display_bg_img` — public image.
- Everything else (loading, sync, session ops) goes through generic ORM RPC (`/web/dataset/call_kw`) — in Laravel these become explicit API endpoints for: load_data_params, load_data, filter_local_data, sync_from_ui, remove_from_ui, search_paid_order_ids, read_pos_orders/read_pos_data_uuid, read_config_open_orders, notify_synchronisation, register_new_device_identifier, set_opening_control, try_cash_in_out/delete_cash_in_out/get_cash_in_out_list, get_closing_control_data, post_closing_cash_details, update_closing_control_state_session, close_session_from_ui, delete_opening_control_session, get_new_partner, load_product_from_pos, get_product_info_pos, get_existing_lots, get_qr_code, action_send_receipt, action_pos_order_cancel, update_customer_display, get_available_slots.

---

## 7. Config parameters (ir.config_parameter)
- `point_of_sale.limited_product_count` (default 5000), `point_of_sale.limited_customer_count` (default 100) — load limits.
- `point_of_sale.log_order_data` — verbose sync logging.
- `point_of_sale.use_lna` — local network access for printers.

## 8. Cron
- Old-session alert: piggybacks the stock scheduler (`stock.rule._run_scheduler_tasks` → `pos.session._alert_old_session`) — activity on sessions open > 7 days.
