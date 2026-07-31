# Odoo 19 POS — Back-office & Auxiliary Modules Analysis (for Laravel + React migration)

Sources analyzed:
- `/home/claude/odoo19/addons/point_of_sale` (views/, wizard/, report/, models/, security/)
- `/home/claude/odoo19-sparse/addons/{pos_hr, pos_discount, pos_loyalty, loyalty, pos_sms}` (fetched from odoo/odoo 19.0 branch — these modules were not present in the local checkout)

---

## 1. point_of_sale back-office

### 1.1 Menu tree (admin app structure)

`views/point_of_sale_view.xml`, plus menuitems scattered in other view files. Root menu **Point of Sale** (`menu_point_root`, visible to `group_pos_manager` + `group_pos_user`):

| Menu | Action / target | Group |
|---|---|---|
| **Dashboard** | `action_pos_config_kanban` → pos.config kanban/list/form (path `point-of-sale`) | all POS users |
| **Orders** (section) | | |
| Orders → Orders | `action_pos_pos_form` → pos.order list/form/kanban/pivot (path `pos-orders`) | user+manager |
| Orders → Sessions | `action_pos_session` → pos.session list/kanban/form (path `pos-sessions`) | user |
| Orders → Payments | `action_pos_payment_form` → pos.payment list/form (default group-by payment method) | user+manager |
| Orders → Preparation Printers | `action_pos_printer_form` (seq 99) | |
| Orders → Customers | `account.res_partner_action_customer` | |
| **Products** (section, `pos_config_menu_catalog`) | | |
| Products → Products | `product_template_action_pos_product` (kanban/list/form, filtered `available_in_pos`) | |
| Products → Product Variants | `product_product_action` | `product.group_product_variant` |
| Products → Combo Choices | `product.product_combo_action` | |
| Products → Pricelists | `product.product_pricelist_action2` | `product.group_product_pricelist` |
| Products → Discount & Loyalty (added by pos_loyalty) | `loyalty.loyalty_program_discount_loyalty_action` | manager |
| Products → Gift cards & eWallet (added by pos_loyalty) | `loyalty.loyalty_program_gift_ewallet_action` | manager |
| **Reporting** (section `menu_point_rep`) | | |
| Reporting → Orders | `action_report_pos_order_all` → report.pos.order graph/pivot | |
| Reporting → Sales Details | `action_report_pos_details` → pos.details.wizard (dialog) | |
| Reporting → Session Report | `action_report_pos_daily_sales_reports` → pos.daily.sales.reports.wizard (dialog) | |
| **Configuration** (section, manager only) | | |
| Config → Settings | `action_pos_configuration` (res.config.settings with module=point_of_sale) | `base.group_system` |
| Config → Presets | `action_pos_preset_form` | `group_pos_preset` |
| Config → Payment Methods | `action_pos_payment_method_form` | user+manager |
| Config → Coins/Bills | `action_pos_bill` | manager |
| Config → Point of Sales | `action_pos_config_tree` (pos.config list) | |
| Config → Note Models | `action_pos_note_model` | |
| Config → Products (sub-section): PoS Product Categories (`product_pos_category_action`), Attributes (`product.attribute_action`) | | |

Security groups (`security/point_of_sale_security.xml`):
- `point_of_sale.group_pos_user` ("User") — can see orders/sessions/payments, run the register.
- `point_of_sale.group_pos_manager` ("Administrator") — implies pos user + `stock.group_stock_user`; sees Configuration menu, settings, chatter on orders.
- `point_of_sale.group_pos_preset` ("Preset Menu") — toggled from settings, unlocks the Presets menu.
- Multi-company record rules on pos.order/line/session/config/payment/payment.method/report.pos.order; bank-statement-line rule restricted to lines with a `pos_session_id` for POS users.

### 1.2 Dashboard (pos.config kanban) — `views/point_of_sale_dashboard.xml`

Kanban `view_pos_config_kanban` (js_class `pos_config_kanban_view`, create disabled, no record open):
- Card shows: config name; badges — "Opened by {user}" (session open by other user), "Opening Control", "Closing Control", "To Close" (warning if session open > 1 day, danger > 3 days, via computed `pos_session_duration`).
- Primary button: **Open Register** / **Continue Selling** (`open_ui`) or **Close** (`open_existing_session_cb`) when in closing control.
- Live stats (computed JSON `statistics_for_current_session`): session start date, opening cash, "Sold" (count + amount of paid orders net of full refunds), "Ongoing" (draft orders count + amount). If no open session: last closing date + last closing cash balance (if cash control).
- Link to outstanding **rescue sessions** (`number_of_rescue_session` → `open_opened_rescue_session_form`).
- Avatar of `current_user_id` (current session responsible).
- Kanban ⋮ menu: View → Orders (`action_pos_order_filtered`), Sessions (`action_pos_session_filtered`); Reporting → Orders (`action_report_pos_order_all_filtered`) — each pre-filtered by that config; Configure (`action_pos_config_modal_edit`, manager).

`pos.config` form (`pos_config_view_form`) is a slim modal: name, warnings (active session, missing chart of accounts), "Is a Bar/Restaurant" toggle on creation ("+ New Shop" mode), Configuration page (Log in with Employees / ePos printer + Epson IP + test widget + cashdrawer link / IoT box: proxy IP, scanner, scale, receipt printer, cashdrawer), "Check list" page (`lna_checklist` onboarding widget), link to full Settings. pos.config list view: name, company, last closing date, last closing balance.

### 1.3 POS Settings (res.config.settings, app "Point of Sale") — ALL settings groups

Architecture note (important for migration): almost every settings field is a `pos_*`-prefixed proxy of a field on the selected `pos.config` (header selector at top of page, sticky, with "+ New Shop" button). `ResConfigSettings.create()` strips `pos_*` values and writes them atomically to the selected pos.config. Warnings shown when a session is open (many settings locked with `readonly="pos_has_active_session"`) and when no chart of accounts is installed. Settings blocks and what they toggle:

**Block: Point of Sale**
- `pos_module_pos_restaurant` — Is a Bar/Restaurant (installs pos_restaurant; floors/tables etc.).
- `pos_use_presets` + `pos_available_preset_ids` + `pos_default_preset_id` — Take out / Delivery / Members presets (per-order pricelist/fiscal-position/timing profiles); link to Configure Presets.

**Block: Payment**
- `pos_payment_method_ids` — payment methods enabled on this POS (locked while session open); link to Payment Methods list.
- `pos_auto_validate_terminal_payment` — auto-validate orders paid by terminal (default true).
- `pos_cash_rounding` + `pos_rounding_method` (account.cash.rounding, only "add a rounding line" strategy supported) + `pos_only_round_cash_method` — cash rounding.
- `pos_use_fast_payment` + `pos_fast_payment_method_ids` — One-click Payment buttons on product screen (excludes terminal/split methods).
- `pos_set_maximum_difference` + `pos_amount_authorized_diff` — max allowed counted-vs-expected difference at closing for non-managers.
- `pos_iface_tipproduct` + `pos_tip_product_id` — tips (default TIPS product).

**Block: PoS Interface**
- `pos_module_pos_hr` — Log in with Employees (badge/PIN); with pos_hr installed the placeholder is replaced by the three employee-rights many2many fields (see §3).
- `pos_iface_big_scrollbars` — large scrollbars for industrial touchscreens.
- `pos_trusted_config_ids` — Share Open Orders between trusted POS configs (bidirectional maintenance in onchange; hidden for restaurant mode/kiosk).
- `pos_show_product_images`, `pos_show_category_images` — hide/show pictures in POS UI.
- `pos_module_pos_appointment` — Online booking (upgrade module).
- `pos_iface_group_by_categ` — group products by category on product screen.

**Block: Product & PoS categories**
- `pos_limit_categories` + `pos_iface_available_categ_ids` — restrict which pos.category trees are shown in the register; link to PoS Product Categories.
- `pos_is_margins_costs_accessible_to_every_user` — show margins & costs in Product Info to non-managers.

**Block: Accounting**
- `sale_tax_id` (company-level) — default sales tax for new products; link to Taxes.
- `account_default_pos_receivable_account_id` (company) — intermediary POS receivable account.
- `pos_order_edit_tracking` — store/flag edited orders in backend (adds `is_edited` columns and payment-change chatter logs).
- `pos_tax_regime_selection` + `pos_default_fiscal_position_id` + `pos_fiscal_position_ids` — Flexible Taxes / fiscal position per order (hidden if presets in use).
- `pos_journal_id` (orders/session closing journal, general or sale) + `pos_invoice_journal_id` (sale journal for invoices) — Default Journals.
- `pos_is_closing_entry_by_product` — breakdown of closing entry sales lines per product.
- `pos_module_pos_avatax` — AvaTax mapping.

**Block: Pricing**
- `pos_use_pricelist` + `pos_available_pricelist_ids` + `pos_pricelist_id` — Flexible Pricelists (currency-consistency enforced against journal/company currency); enables `product.group_product_pricelist` globally.
- `pos_restrict_price_control` — only POS managers may change line prices ("Price Control").
- `pos_iface_tax_included` — receipt price display: `subtotal` (tax-excluded) or `total` (tax-included), radio.
- `pos_manual_discount` — allow per-line manual discounts (default on).
- `pos_module_pos_discount` — Global Discounts (installs pos_discount; then shows Discount Product + Discount % — see §4).
- `module_pos_pricer` — Pricer electronic shelf tags.
- `module_loyalty` — Promotions, Coupons, Gift Card & Loyalty programs (installs loyalty/pos_loyalty; buttons to the two program list actions).

**Block: Bills & Receipts**
- `pos_is_header_or_footer` + `pos_receipt_header` + `pos_receipt_footer` — custom receipt header/footer text.
- `pos_iface_print_auto` + `pos_iface_print_skip_screen` — automatic receipt printing / skip preview screen.
- `pos_module_pos_sms` — SMS receipt (installs pos_sms; then shows `pos_sms_receipt_template_id`, see §6).
- `point_of_sale_use_ticket_qr_code` (company) + `point_of_sale_ticket_portal_url_display_mode` (qr / url / qr+url) — print QR/URL on receipt so customers can self-request their invoice from the portal.
- `point_of_sale_ticket_unique_code` (company) — 5-char unique ticket code (used with the portal invoice-request form).
- `pos_basic_receipt` — print basic ticket without prices (gifts).

**Block: Payment Terminals** (common to all POS; each is a `module_pos_*` installer boolean plus a shortcut that opens a pre-filled pos.payment.method form): Adyen, Stripe, Viva.com, Razorpay, Mercado Pago, Pine Labs, QFPay.

**Block: Connected Devices**
- `pos_other_devices` — ePos printer without IoT box + `pos_epson_printer_ip` (+ test widget, link cashdrawer).
- `pos_customer_display_bg_img` — customer display background image.
- `pos_is_posbox` — IoT Box: `pos_proxy_ip`, `pos_iface_scan_via_proxy` (barcode/card reader), `pos_iface_electronic_scale`, `pos_iface_print_via_proxy` (receipt printer), `pos_iface_cashdrawer`.

**Block: Preparation**
- `pos_is_order_printer` + `pos_printer_ids` — preparation (kitchen/bar) printers; add/manage printer dialogs.
- `pos_note_ids` — predefined internal note models for order lines (locked while session open).

**Block: Inventory**
- `pos_picking_type_id` — operation type used for POS pickings.
- `pos_ship_later` + `pos_warehouse_id` + `pos_route_id` (adv. routes) + `pos_picking_policy` (direct/one) — Ship Later.
- `barcode_nomenclature_id` (company) + `pos_fallback_nomenclature_id` — barcode nomenclatures.
- `update_stock_quantities` (company, dev mode) — update stock in real time vs at session close.

Other notable `pos.config` fields not surfaced in Settings but relevant to parity: `uuid`, `access_token`, sequences (`order_seq_id`, `order_backend_seq_id`, `order_line_seq_id`, `device_seq_id` — order refs formatted `YY{device}-{config_id}-{seq}` with 3-digit tracking number), `cash_control` (computed: any cash payment method), `default_bill_ids` (coins/bills for opening count), `last_data_change`, `fallback_nomenclature_id`, trusted-config sync (`notify_synchronisation`, `read_config_open_orders` for cross-register order sharing over the bus).

### 1.4 Products & categories management (POS specifics)

- **pos.category** (`pos_category_view.xml`, model `pos_category.py`): fields `name` (translatable), `parent_id`/`child_ids` (tree), `sequence`, `image_512/128`, `color`, `hour_after`/`hour_until` (availability window — used by self-order/online, form shows it hidden by default). Views: form (image avatar, parent, color picker, availability), list with drag-handle sequence, kanban with image. Used to browse products on the register screen; distinct from internal `product.category` (accounting/stock).
- **product.template extensions** (`product_view.xml`, `product_template.py`): checkbox `available_in_pos` next to "Sales" option; "Point of Sale" notebook page (visible when available_in_pos) with `to_weight` (weighed via scale), `pos_categ_ids` (m2m to pos.category, color tags), `color`, `public_description`, and Upsell & Cross-Sell `pos_optional_product_ids`. `pos_sequence` orders products in the POS-specific list view (drag handle). List views add POS Category and Available in POS optional columns; search adds POS category filter/groupby and "Point of Sale" (available_in_pos) filter.
- **Quick create/edit from the register**: `product_template_view_form_normalized_pos` — a minimal modal form (image, name, barcode, storable/tracking, sales price, taxes, POS category, color) used by `product_template_action_add_pos` / `product_template_action_edit_pos` (target=new dialogs). Product creation from POS defaults `available_in_pos=True` and variant creation mode `no_variant`.
- **Combos**: menu "Combo Choices" (product.combo); POS extends the combo form with `qty_max`/`qty_free` ("Maximum X items / Includes Y items") and `base_price`; combo item product defaults `available_in_pos`.
- **Coins/Bills** (`pos.bill`): name + value + `pos_config_ids` (empty = all POS); used for the opening/closing cash count denominations.
- **Presets** (`pos.preset`): name, image, `pricelist_id`, `fiscal_position_id`, `identification` (selection: none/name/address), `is_return` (return mode, tip suggests 0€ pricelist), `color`, timing (`use_timing`, `resource_calendar_id` schedule, `slots_per_interval` orders per `interval_time` minutes, attendance page); stat buttons to linked orders and configs.
- **Note models** (`pos.note`): editable list of name+color, sequence — quick internal notes for order lines.
- **Preparation printers** (`pos.printer`): name, `printer_type` (iot | epson_epos), `epson_printer_ip` or `proxy_ip`, `product_categories_ids` (only prints items of linked pos categories), test-print widget.
- **UoM**: `is_pos_groupable` flag on uom.uom (dev mode) — whether identical lines merge.
- **Partners**: partner form gets `barcode` (customer loyalty card scan) in a "Point Of Sale" group and a "PoS Orders" stat button.
- Payment page of product screen surfaces `pos_optional_product_ids`; attributes menu available for variants.

### 1.5 Orders list & form (what admins can do)

Model `pos.order` — states: `draft` (New) → `paid` → `done` (Posted) / `cancel`. Key fields: name (Order Ref), `pos_reference` (Receipt Number), `tracking_number`, `uuid` (unique), session_id, config_id, user_id (or employee via pos_hr), partner_id, pricelist, fiscal position, preset + `preset_time`, `floating_order_name`, amounts (total/tax/paid/returned/difference), `margin`/`margin_percent` (+ `is_total_cost_computed`), lines, payment_ids, `account_move` (invoice), `invoice_status` (invoiced / to_invoice), `to_invoice`, `is_refund`, `refunded_order_id` / `refund_orders_count` / `has_refundable_lines`, picking_ids/picking_count/failed_pickings, `shipping_date`, `ticket_code` (5-char portal code), `email`/`mobile` (contact details), `nb_print`, `is_tipped`/`tip_amount`, `is_edited`/`has_deleted_line` (edit tracking), `general_customer_note`/`internal_note`, `source` ('pos'), `reversed_move_ids`.

Form `view_pos_pos_form` (create disabled; chatter for managers):
- Header buttons: **Payment** (opens pos.make.payment wizard; only draft), **Invoice** (`action_pos_order_invoice`; only paid/done and not yet invoiced), **Return Products** (`refund`; hidden if draft or nothing refundable), statusbar draft/paid/done (or draft/cancel).
- Stat buttons: Pickings (`action_stock_picking`, red when failed), Invoice (`action_view_invoice`), Refunds (`action_view_refund_orders`), Refunded Order (`action_view_refunded_order`).
- Products page: editable (only in draft) order lines list — product (label/section/note widget), lot/serials, qty, customer note, UoM, unit price, cost/margin/margin% (optional, if computed), Disc.%, taxes (after fiscal position), subtotal excl/incl, refunded qty; kanban for mobile; totals footer with tax, total, total paid (with rounding), margin (+%).
- Payments page: pos.payment lines (date, method restricted to config's methods, amount, payment mode, card number/brand/cardholder) — editable while not invoiced/posted/printed; footer amount total/paid/difference.
- Extra Info page: session journal entry (accounting managers), pos_reference, tracking number, company, pricelist, preset & preset time, floating order name; Contact info (email with "send" button, mobile).
- Customer Note page: `general_customer_note` (readonly).

List `view_pos_order_tree` (create/duplicate disabled): header **Create Invoices** server-ish button (`action_create_invoices` → opens `pos.make.invoice` wizard for selection), columns name, session, date, config, receipt number, tracking (opt), customer, employee avatar, total (summed), state badge, invoice status badge, edited flag. Decorations: draft=info, cancel=muted. Also kanban (mobile), pivot (date × margin/total) and graph views (`action_pos_sale_graph` uses domain state not in draft/cancel & not invoiced).

Search filters: invoiced / posted / cancelled / order date; group by session, user, POS, customer, status, date. Fields searchable: name, pos_reference, date, tracking number, user, partner, session, config, product in lines.

Contextual server actions (list/kanban/form): **Cancel Order** (`action_pos_order_cancel` — only draft orders; refuses future preset-dated orders; notifies registers over bus) and **Send Email** (`action_send_mail` mass-mail composer with receipt template). Refund flow (`refund`): copies the order into the *currently open session* of the same config (error if none) with negative quantities for non-refunded qty, links `refunded_order_id`, then opens the new draft refund order (admin then registers payment via the Payment wizard). Invoicing a paid order post-session creates the invoice, payment moves, reconciliation, and reversal moves against the closing entry (`_generate_pos_order_invoice`, `_create_misc_reversal_move`).

Order lines also have standalone list/form views (`pos.order.line`) incl. "All sales lines" and a today-filtered action. Invoices get a "POS Orders" stat button and `reversed_pos_order_id` on account.move; the invoice PDF report shows "using {payment method}" and Source Invoice for refunds.

### 1.6 Payments (pos.payment)

Read-only list/form (create/edit/delete disabled from UI). List: date, method, order, cashier avatar, amount; search group-bys: payment method (default), session. Form additionally exposes card_type, card_brand, card_no, cardholder_name, issuer bank, auth code, payment ref no, transaction id, `payment_method_payment_mode`. Payment methods (`pos.payment.method`): name, image, sequence, `journal_id` (cash journal ⇒ type cash; bank; none ⇒ pay_later "Customer Account"), `split_transactions` (one AR line per order, requires customer), outstanding/receivable accounts, `config_ids`, `payment_method_type` integration selector (none / terminal / qr_code), `use_payment_terminal` (provider selection), `qr_code_method`, archived ribbon; provider "cards" widget advertising terminal integrations.

### 1.7 Sessions list/form and closing review

Model `pos.session`, states: `opening_control` → `opened` → `closing_control` → `closed`. Fields: name (Session ID), config, `user_id` (Opened By), start/stop datetimes, `opening_notes`/`closing_notes`, cash fields — `cash_register_balance_start`, `cash_register_balance_end_real` (counted), `cash_register_balance_end` (theoretical), `cash_register_difference`, `cash_real_transaction` (cash in/out total); `cash_control`, `cash_journal_id`, `statement_line_ids` (cash moves), order_ids/order_count, picking_ids/count/failed, `move_id` (closing journal entry), `bank_payment_ids`, `total_payments_amount`, `rescue` flag (recovery session for orphan orders), `update_stock_at_closing`.

Form `view_pos_session_form` (create/edit disabled, chatter+activities):
- Header: **Continue Selling** (`open_frontend_cb`), **Close Session & Post Entries** (`action_pos_session_closing_control`), statusbar.
- Stat buttons: Orders, Pickings (red if failed), Payments (sum → `action_show_payments_list`), Journal Items (`show_journal_items` — session move + related invoices/payment moves lines), Cash Register (`show_cash_register` — bank statement lines).
- Body: opened by, config, journal entry, opening/closing dates, opening balance, counted closing balance.

List: name, config, opened-by avatar, start/stop, opening balance, counted balance, theoretical balance, state badge. Kanban for mobile. Search: my sessions, in progress (opened), opening date filter; group by user/POS/state/open date/close date. A `mail.activity.type` "Session open over 7 days" exists; `_alert_old_session` schedules an activity nagging managers to close.

Closing logic worth parity (`pos_session.py`):
- `action_pos_session_closing_control` → refuses if draft orders exist; sets closing_control + stop_at; if no cash control closes directly; rescue sessions compute counted cash automatically.
- `_validate_session` → creates the closing account move (`_create_account_move`: grouped sales lines — optionally per product, tax lines, rounding difference line, combine/split receivable lines per payment method, invoice receivable lines, stock output lines, cash statement lines, bank `account.payment`s with profit/loss difference lines), reconciles everything, creates end-of-session picking if stock updates deferred, posts cash difference as profit/loss statement line ("Cash difference observed during the counting (Loss/Profit)").
- If accounts are missing/imbalanced it opens the **pos.close.session.wizard** (see §2.3). `close_session_from_ui` returns `{successful, message, redirect}` payloads for the register's closing popup; detaches future preset-dated draft orders instead of blocking; a second concurrent close routes orders into a **rescue session**.
- Cash in/out during a session creates `account.bank.statement.line`s (`try_cash_in_out`), deletable (`delete_cash_in_out`) with permission checks; message-posted to chatter.
- `get_closing_control_data` feeds the front-end closing popup: default cash details (opening + payments + moves), per non-cash method expected amounts, number of draft orders.
- Opening: `set_opening_control(cashbox_value, notes)` posts an "Opening" cash-details message and sets state to opened.

### 1.8 Reporting

**A. Orders Analysis — `report.pos.order`** (SQL view `report/pos_order_report.py`, one row per pos.order.line):
- Measures: `price_total` (tax incl., currency-rate normalized), `price_subtotal_excl`, `price_sub_total` (w/o discount), `total_discount`, `average_price` (avg aggregator), `margin`, `product_qty`, `nbr_lines`, `delay_validation` (days), count of orders.
- Dimensions: date, order, customer, product, product template, product category, **POS category** (first of the template's pos_categ_ids), state, user (± employee via pos_hr), company, journal, invoiced (bool), config, pricelist, session, **payment method** (first payment of the order).
- Views: pivot (product category × month, measures order count/qty/price_total), bar graph (price_total per product category), optional list; search with invoiced/not-invoiced/not-cancelled (default) filters and group-bys (user, POS, product, product category, payment method, POS category, month); saved filter "Per session" (group by date+session).

**B. Sales Details report** (`models/report_sale_details.py` + QWeb `views/pos_session_sales_details.xml`, report action `sale_details_report`, qweb-pdf on pos.session): callable three ways — Reporting → Sales Details wizard (date range × configs), Reporting → Session Report wizard (one session, ± per-employee sub-reports), and from the register / session form ("Daily Sales Report"). Data returned by `get_sale_details(date_start, date_stop, config_ids, session_ids)`:
- **Sales** section: products sold grouped by POS category (name/barcode/qty/unit price/disc %/uom/total excl., combo components label), per-category qty+total, grand total & qty.
- **Taxes on sales** + tax totals (per tax: base + tax amount) and the same for **Refunds** (refund products, refund taxes).
- **Payments**: per session × payment method: expected total, counted, difference, cash moves detail (opening, cash in/out list, closing differences incl. profit/loss detection from difference moves and bank account.payments); aggregate `payments_per_method` when multi-session; `cash_rounding_total`.
- **Discounts**: number of discounted lines + total discount amount.
- **Invoices**: per session invoice list (`_get_invoice_total_list`) + invoice total; total payments amount.
- **Session Control** block: opening/closing notes, state, dates, session/config names; title switches to "Daily Sales Report" for a single session.

**C. Session Report wizard** — see §2.4. **D. Digest KPI** `kpi_pos_total` added to digest. **E. User Labels** (`report_userlabel` qweb-pdf on res.users): prints cashier badge labels with barcode — used with pos_hr badges. **F. Invoice report extensions** as noted in 1.5.

### 1.9 Receipt / ticket templates

- The customer receipt itself is rendered client-side (OWL `order_receipt` component) — not a server QWeb report. Server-side artifacts: the Sales-Details/Daily-Report PDF (above), the invoice PDF additions, and the mail receipt: `action_send_receipt(email, ticket_image, basic_image)` emails the receipt image via template `point_of_sale.email_template_pos_receipt` (attaches ticket PNG, optional basic no-price ticket, and invoice PDF when invoiced); `action_send_mail` for mass emailing from the orders list.
- **Portal ticket flow** (`views/pos_ticket_view.xml` + controllers): receipt can carry a QR/URL (`point_of_sale_use_ticket_qr_code`, display mode qr/url/both) → `/pos/ticket` "Invoice Request" form (ticket nr + date + 5-char unique `ticket_code`) → `ticket_validation_screen` where the customer confirms/fills billing address (+ country-specific required partner/invoice fields) and self-generates the invoice (`/pos/ticket/validate`).
- Receipt content options in config: header/footer text, basic receipt (no prices), automatic printing, tax display incl./excl.

---

## 2. Wizards (point_of_sale/wizard)

### 2.1 `pos.details.wizard` (Sales Details)
Transient: `start_date` (default = earliest start of latest sessions in last 2 days), `end_date` (default now, onchange keeps range valid), `pos_config_ids` (default all). `generate_report()` → report action `point_of_sale.sale_details_report` with `{date_start, date_stop, config_ids}` → the aggregated Sales Details PDF across configs/date-range (payments shown per method aggregate, `show_payment_per_method=True`).

### 2.2 `pos.make.payment` (register payment on an order)
Opened from the order form "Payment" button (draft orders, e.g. after a backend refund). Fields: config (from order's session), `amount` (default = remaining due; for full refunds, refunds exactly the originally paid amount), `payment_method_id` (session's methods, cash first), `payment_name` (reference), `payment_date`. `check()`: validates split-transaction methods require a customer; rounds amount per config cash-rounding rules; `order.add_payment(...)`; if fully paid → `_process_saved_order` (marks paid, creates picking, posts, sends over bus) else relaunches the wizard for another split payment.

### 2.3 `pos.close.session.wizard` (force close)
Raised by the closing flow when the closing entry cannot balance (e.g. missing accounts / difference on non-cash methods). Fields: `message` (explanatory), `amount_to_balance`, `account_id` (destination account, may be readonly), `account_readonly`. Button **Close Session** → `session.action_pos_session_closing_control(account_id, amount_to_balance)` which injects a balancing journal item.

### 2.4 `pos.daily.sales.reports.wizard` (Session Report)
Field: `pos_session_id` (required). `generate_report()` → same `sale_details_report` action with `{config_ids: session.config, session_ids: [session]}` ⇒ one-session "Daily Sales Report" PDF including Session Control (opening/closing notes) section. pos_hr extends it with `add_report_per_employee` (default true) + computed `employee_ids` → appends one "Employee Sales Report" section per employee who sold in the session.

### 2.5 `pos.make.invoice` + `pos.confirmation.wizard` (batch invoicing)
From the orders list header button. `pos.make.invoice`: `consolidated_billing` (default true — one invoice per (config, partner, user, fiscal position) group), `count`. Validates: only paid/done non-invoiced orders; refund orders whose original was invoiced must be invoiced individually; every order needs a partner — if a single partner exists among selection and some orders lack one, `pos.confirmation.wizard` asks to assign that customer to the partner-less orders, then reopens the invoice wizard. Creates invoices via `_generate_pos_order_invoice` and opens the resulting invoice(s).

---

## 3. pos_hr — Employee login, permissions, attribution

Auto-installed link module (point_of_sale + hr). Activated per-config via `module_pos_hr`.

### Data model
- `pos.config`: three m2m employee lists — `minimal_employee_ids`, `basic_employee_ids`, `advanced_employee_ids` ("manager access"). If **all lists empty ⇒ every company employee can log in**. `write()` auto-adds employees of all `group_pos_manager` users to advanced (auto-creating an employee for a manager user if missing); onchange handlers keep the three lists mutually exclusive and prevent demoting POS-manager users. `_employee_domain(user_id)` builds the loadable-employee domain (company + listed employees + current user's own employee).
- `hr.employee` (pos.load.mixin): loads `name, user_id, work_contact_id` into the register plus computed extras — `_role` (`manager` if the employee's user is in group_pos_manager or in advanced list; `minimal`; else `cashier`), `_user_role: admin`, and `_barcode`/`_pin` as **SHA-1 hashes** (`get_barcodes_and_pin_hashed`, sudo-read then hashed; respects record rules). Deletion blocked while an active session may use the employee.
- `pos.order`: `employee_id` (Cashier, m2one hr.employee) + stored computed `cashier` name (falls back to user_id). Order chatter logs append "Cashier X" (from `current_cashier_id` context sent by the client on sync).
- `pos.payment`: related stored `employee_id` (from order) — payments carry the cashier.
- `pos.session`: `employee_id` (current cashier, tracked); open/close chatter messages authored as the employee's partner; `get_closing_control_data` adds `amount_per_employee` per payment method and `moves_per_employee` (cash in/out per employee) for the closing popup.
- `account.bank.statement.line`: `employee_id` (who did the cash move); cash in/out list annotated with cashier name.
- `report.pos.order`: adds `employee_id` dimension (+ Employee group-by filter and optional list column).
- `res.partner` loading includes employees' work contacts (used as partner on cash moves).

### Back-office UI
- Settings/config: the "Log in with Employees" setting expands to the three rights fields (Advanced / Basic / Minimal, company-domain filtered).
- Orders: form shows `employee_id` instead of `user_id` (user shown only when no employee); list shows employee avatar; search replaces User with **Cashier** field + group-by Cashier.
- Session Report wizard: per-employee sub-report option (see §2.4); dedicated abstract report `report.pos_hr.single_employee_sales_report` reuses the sales-details engine filtered by `employee_id` (renamed "Employee Sales Report", Session Control section removed).
- User Labels report (badge printing) pairs with employee barcode badges.

### Frontend behavior (for parity)
- Register opens on a **Login Screen**; select cashier from list, scan badge barcode (compared as Sha1 hash) or type PIN (masked NumberPopup, Sha1-compared). Employees with a PIN must confirm it; wrong PIN → notification.
- Selected cashier stored in `sessionStorage` per config (`connected_cashier_{config.id}`) and written to `pos.session.employee_id` (buffered while offline, flushed on reconnect).
- Every new order and every added line stamps `order.employee_id = current cashier`; empty orders are re-owned on cashier switch.
- Role gating: `_role === 'manager'` unlocks admin actions — price control (numpad price mode falls back to quantity for non-managers when `restrict_price_control`), payment editing (`canEditPayment`), product creation, closing controls, etc. `minimal` is a further-restricted role (limited UI). Going back to the backend from the register requires the cashier linked to the logged-in user.
- Sync context sends `current_cashier_id` so backend logs attribute changes to the employee.

---

## 4. pos_discount — Global discount (moderate)

- Config fields: `iface_discount` (legacy toggle), `discount_pc` (default %, default 10.0), `discount_product_id` (sale_ok product used as the discount line; default product `pos_discount.product_product_consumable` assigned on install to configs without open sessions). Settings expose Discount Product (required) + Discount %. `open_ui` blocks if feature on but product missing. Discount product is registered as a "special product" (always loaded even if not available_in_pos).
- Frontend: a **% Discount button** in Product Screen control buttons opens a NumberPopup pre-filled with `discount_pc` (clamped 0–100) → `pos.applyDiscount(percent)`. Implementation groups discountable lines by tax combination, uses account tax helpers `prepare_global_discount_lines` to create **one negative discount line per tax group** on the discount product (price computed so the % applies to the tax-inclusive total per group; `extra_tax_data.discount_percentage` retained). Discount lines re-compute reactively on any order/line change while draft (`globalDiscountPc` listener with debounce); editing selects price numpad mode; discount lines excluded from merge on order transfer and from refunds.
- Accounting: `account.move.line._get_discount_lines` treats invoice lines with the config's discount product as discount lines.

## 5. pos_loyalty — Coupons, Promotions, Gift cards, eWallet, Loyalty (moderate)

Auto-installed bridge between `loyalty` and `point_of_sale`.

### Program data model (base `loyalty` module)
- **loyalty.program**: name, `program_type` ∈ {coupons, gift_card, loyalty, promotion, ewallet, promo_code, buy_x_get_y, next_order_coupons}; `trigger` (auto | with_code); `applies_on` (current / future / both); currency, optional pricelists restriction, date_from/date_to, limit_usage/max_usage, portal visibility & point name, `rule_ids`, `reward_ids`, `communication_plan_ids` (loyalty.mail: trigger create/points_reach → mail template), coupon_ids/coupon_count, `is_nominative` (loyalty/ewallet on future), `is_payment_program` (gift_card/ewallet).
- **loyalty.rule** (earning conditions): product scoping (products / category / tag / domain), `minimum_qty`, `minimum_amount` (+tax mode), `reward_point_amount`, `reward_point_mode` (per order / per money / per unit), `reward_point_split`, `mode` (auto / with_code) + `code`.
- **loyalty.reward**: `reward_type` (discount | product); discounts — `discount`, `discount_mode` (percent / per_point / per_order …), `discount_applicability` (order / cheapest / specific products via ids/category/tag/domain), `discount_max_amount`, `discount_line_product_id` (product used on the reward line), `is_global_discount`; free products — `reward_product_id` or tag/ids (multi-product choice), `reward_product_qty`; `required_points`, `clear_wallet`.
- **loyalty.card** (= coupon/gift card/eWallet/loyalty account): program, partner, `points` (tracked), unique generated `code`, `expiration_date`, use_count, history_ids (loyalty.history).

### pos_loyalty additions
- Program: `pos_ok` + `pos_config_ids` (empty ⇒ all POS; currency must match config), `pos_order_count`, `pos_report_print_id` (report printed for generated gift cards; validated with mail template via communication plan). `pos.config._get_program_ids()` resolves applicable programs (pos_ok, config, dates, pricelists, currency, usage limit). Menus: Products → **Discount & Loyalty** and **Gift cards & eWallet** program lists; settings buttons under the loyalty setting.
- Card: `source_pos_order_id` (+related partner), POS mail template for coupons, `use_count` includes POS usage, `get_gift_card_status` (scan validation), `get_loyalty_card_partner_by_code` (identify customer by loyalty card scan).
- Rule: computed `valid_product_ids`/`any_product` (available_in_pos-filtered), `promo_barcode` (auto-generated barcode alternative to code); barcode rules for coupons/gift cards.
- Order lines: `is_reward_line`, `reward_id`, `coupon_id`, `reward_identifier_code`, `points_cost`; reward discount lines count as discounts in the Sales Details report; reward lines not refundable. Rewards in use can't be deleted (archived instead).
- Server RPC flow: `pos.config.use_coupon_code(code, date, partner, pricelist)` validates and returns program/coupon/points payload; `pos.order.validate_coupon_programs(point_changes, new_codes)` re-checks points/codes at payment; `confirm_coupon_programs(coupon_data)` creates/updates cards after order sync (gift card activation with expiry & partner, points updates, loyalty history lines, emails/prints per communication plan).

### Client behavior (summary)
Programs/rules/rewards and relevant cards are loaded into the register. Automatic promotions evaluate continuously (mutex-protected `updatePrograms` recomputes claimable rewards on order/line/partner/pricelist changes); "Enter Code" control button + barcode scan activate coupons/promo codes/gift cards (rich error messages: expired, not yet valid, wrong pricelist, already applied, unpaid gift card confirmation); reward picker dialog when multiple rewards claimable; free-product suggestions (`getPotentialFreeProductRewards`); gift card sale popup (`manage_giftcard_popup` — set code/amount, prints/emails card), eWallet top-up options; gift card / eWallet balances act as **payment-like discount rewards** (1 point = 1 currency) requiring a customer for eWallet; points preview (won/spent/balance) shown per order; partner list shows loyalty points; receipt shows reward lines and new coupon codes; refunds guard against reward abuse. Points changes and new coupons synced at order validation (`preSyncAllOrders`/`postSyncAllOrders`/`confirm_coupon_programs`).

## 6. pos_sms — Receipt via SMS (moderate)

- `pos.config.sms_receipt_template_id` (sms.template on pos.order model; default data template "POS: Sent Order Confirmation via Text": company name, pos_reference, formatted amount). Settings: enable `pos_module_pos_sms` → choose Receipt template (required).
- `pos.order.action_sent_message_on_sms(phone, _, basic_image)`: guards (feature on + template + phone), builds an `sms.composer` in comment mode with the template and sends; stores the phone on `order.mobile`.
- Frontend: Receipt screen patch — phone input shown when module active; "SMS" send button next to email calls the action. (Note: unlike email, the SMS is template text only, no ticket image.)

## 7. Other POS-relevant items worth parity

- **Rescue sessions**: automatic recovery sessions collect orders synced after their session closed; dashboard surfaces them; must be closed/posted manually.
- **Trusted configs / shared open orders**: cross-register order visibility + bus `SYNCHRONISATION` notifications (`notify_synchronisation`, `read_config_open_orders`).
- **Order edit tracking**: `is_edited`, `has_deleted_line`, payment-change chatter logs (`_create_pm_change_log`) — audit trail when `order_edit_tracking` on.
- **Cash in/out** with reasons, partner attribution, chatter messages, delete permission gates (`_has_cash_move_permission` / delete perm loaded into config payload).
- **Ship later**: creates deferred pickings with warehouse/route/policy; `shipping_date` on order.
- **Portal invoice self-service** (QR/unique code) — see §1.9.
- **Customer display** (separate route/assets, background image config) and **kiosk mode** flag (`is_kiosk_mode` hides several settings).
- **Presets with schedules/slots** (order timing capacity) — also feed `preset_time` on orders and block cancelling future orders.
- **Barcode nomenclatures** incl. fallback nomenclature; barcode rules for products, partners, cashiers, coupons.
- **Digest KPI** (`kpi_pos_total`) and mail template for receipts; activity type for stale sessions.
- **pos_restaurant** exists in the local tree (floors/tables, order printers) — out of scope here but its settings hook into the same config/settings architecture (`module_pos_restaurant`).
- Sequences per config (order / backend / line / device) with year-prefixed reference format — needed to reproduce receipt numbering (`YY{device}-{config}-{seq}` + 3-digit tracking number).
- `pos.load.mixin` pattern: every model exposes `_load_pos_data_domain/_fields/_read` — the contract by which the register bootstraps its local dataset; a Laravel equivalent needs a per-entity "POS payload" serializer with config-scoped domains.
