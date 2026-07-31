# Odoo 19 Point of Sale — Frontend (Client App) Inventory

Source analyzed: `/home/claude/odoo19/addons/point_of_sale/static/src`
Framework: OWL (Odoo Web Library) components + Odoo "services" registry. ~166 JS files, ~90 XML templates.
Purpose of this document: exhaustive feature inventory to drive a feature-parity spec for a React + PWA rebuild.

---

## 0. App architecture at a glance

- **Entry point**: `app/main.js` — mounts a `Loader` component, then mounts the root `Chrome` component (`app/pos_app.js`), registers the service worker (`/pos/service-worker.js`), installs a `beforeunload` guard (warns if offline or if paid orders are not yet synced; deletes the session via `navigator.sendBeacon` if still in `opening_control` state).
- **Root component**: `Chrome` (`app/pos_app.js`) — renders `Navbar` + current page (from the router registry `pos_pages`), mounts `MainComponentsContainer` (dialogs/notifications), starts the idle timer (5-min → SaverScreen; 2-min on LoginScreen), and reactively pushes order data to the **customer display** on every relevant state change (via `CustomerDisplayPosAdapter`).
- **Core singleton services** (Odoo service registry):
  - `pos` (`app/services/pos_store.js`, ~3,150 lines) — the central store (`PosStore`), reactive, holds config/session/currency/models, current order selection, numpad mode, pending-order sync queues, navigation helpers, product catalog filtering, order line creation logic (configurator/combo/lots/scale), preparation-printer dispatch, etc. Uses a "lazy getter trap" (`lazy_getter.js`) for cached derived getters.
  - `pos_data` (`app/services/data_service.js`, `PosData`) — data loading, ORM proxy, IndexedDB persistence, offline queue, websocket channel management. Exposes `models` (the reactive record store).
  - `pos_router` (`app/services/pos_router_service.js`) — client-side URL router with real pathname routes (`/pos/ui/<configId>/product/<orderUuid>` etc.), popstate handling, param parsing.
  - `number_buffer` (`app/services/number_buffer_service.js`) — global keypad/keyboard input buffer singleton (stack of "buffer holders" per screen).
  - `barcode_reader` (`app/services/barcode_reader_service.js`) — nomenclature parsing + callback dispatch.
  - `hardware_proxy` (`app/services/hardware_proxy_service.js`) — IoT box / hw_proxy connectivity.
  - `printer` (`app/services/printer_service.js`) — receipt printing abstraction (device printer or `window.print` fallback).
  - `pos_scale` (`app/screens/scale_screen/scale_service.js`) — electronic scale.
  - `renderer` (`app/services/render_service.js`) — renders OWL components off-screen to HTML/canvas/JPEG (used for printing and emailing receipts).
  - Also: `alert_service`, `contextual_utils_service` (currency/format helpers put on `env.utils`: `formatCurrency`, `isValidFloat`, `formatProductQty`...), `report_service`, `pos_printer_service`, `sound_effects` override (beep/scan-error/bell), `debug_widget` (dev tool).
- **Model layer** (`app/models/*` + `app/models/related_models/*`): a client-side relational ORM. `createRelatedModels(relations, modelClasses, opts)` builds reactive model stores from field/relation metadata fetched from the server (`pos.session.load_data_params`). Records are class instances (`Base` subclasses) with: `uuid` (client key for dynamic models), `isSynced` (has numeric server id), `isDirty()`/`_dirty` change tracking, `serializeForORM()` (produces ORM commands incl. `relations_uuid_mapping` for new related records), `serializeForIndexedDB()`, event listeners (`create`/`update`/`delete`) per model store, indexed lookups (`getBy("barcode", ...)`, `getAllBy("id")`).
- **Registered model classes**: `pos.order`, `pos.order.line`, `pos.payment`, `pos.config`, `pos.session` (implicit), `pos.category`, `pos.preset`, `res.partner`, `product.template`, `product.product`, `product.pricelist`, `product.pricelist.item` (implicit), `account.fiscal.position`, `account.cash.rounding`, `decimal.precision`, `res.currency`, `uom.uom`, `product.tag`, `product.attribute.*`, `pos.pack.operation.lot` (implicit), `stock.picking.type` (implicit), etc. Accounting mixins: `PosOrderAccounting`, `PosOrderlineAccounting`, `ProductTemplateAccounting` reuse the shared `@account/helpers/account_tax` engine (same tax math as backend).

---

## 1. Screens & major components

Screens are registered in the `pos_pages` registry with a URL route. Each order stores its "current screen" (`order.uiState.screen_data`) so switching orders restores the right screen.

### 1.1 LoginScreen (`app/screens/login_screen/`)
- Route: `/pos/ui/<config>/login`. Shown when no cashier is set (or after logout / idle).
- Purpose: cashier selection/opening gate. In community (no `pos_hr`) there is a single user; "Open register" logs in `pos.user` and navigates to the previous screen or ProductScreen (creating an order if needed).
- UI: clock (`useTime`), open-register button, "Backend" back button (`closePos`, which syncs pending orders and redirects to `/odoo/...`).
- Cashier persisted in `sessionStorage` (`connected_cashier_<configId>`).

### 1.2 Opening control (popup, not a screen) (`components/popups/opening_control_popup/`)
- Auto-shown on ProductScreen mount when `session.state == "opening_control"`.
- UI: opening cash input (pre-filled with `cash_register_balance_start`), notes, coin/bill counting popup (`MoneyDetailsPopup` — denominations grid computing the total; also opens cash drawer), count of draft orders carried over.
- Confirm → RPC `pos.session.set_opening_control(session, cash, notes)` → session state = "opened". Closing the popup without opening the session exits the POS.

### 1.3 ProductScreen (`app/screens/product_screen/`) — main register screen
- Route: `/pos/ui/<config>/product/{orderUuid}`.
- Left pane (desktop) / toggleable panes (mobile via `pos.mobile_pane`):
  - **OrderSummary** (`order_summary/`): scrollable list of `Orderline` components + `OrderDisplay` totals (subtotal, taxes, total). Line click selects/deselects; long-press on a line re-opens the configurator/combo editor to edit it (blocked if the line was already sent to the kitchen). Handles numpad input → qty/discount/price on the selected line, tip-line protection, negative toggle, "decrease quantity" flow that creates a compensating negative line when quantity is reduced below the saved (already sent/synced) quantity.
  - **Numpad** (`components/numpad/`): 1–9, 0, decimal, +/- sign, Backspace, and mode keys **Qty / % (discount) / Price**. Mode keys gated by config: `manual_discount`, `restrict_price_control` (price only for managers), "minimal" cashier role restrictions; price disabled for combo child lines. Refund orders block qty/discount/price edits entirely (alert).
  - **ActionpadWidget** (`action_pad/`): Customer button (opens PartnerList), **Pay** button (→ PaymentScreen after lot-completeness confirmation), optional fast-payment buttons (`validateOrderFast` with a one-click payment method), back button on mobile.
  - **ControlButtons** (`control_buttons/`): customer note & internal note buttons (`orderline_note_button` — note popups with predefined note tags), Fiscal Position selector (SelectionPopup incl. "Original Tax"), Pricelist selector, **Refund** (navigates to TicketScreen filtered SYNCED), Cash In/Out, product info, Save order for later (`clickSaveOrder` syncs and opens an empty order), Cancel order, "More..." popup on small screens (`ControlButtonsPopup`).
- Right pane:
  - **CategorySelector** (`components/category_selector/`): pos.category tree (root categories + drill-down; selecting the selected category goes up a level); category images.
  - **Search input**: live in-memory search (`pos.searchProductWord`) over `product.searchString` (name, barcode, default_code, normalized); Enter triggers a server search (`loadProductFromDB` — domain over name/barcode/default_code incl. variants, paginated by 30) for products not loaded locally.
  - **Product grid/list** (`ProductCard`): shows image, name, price (`displayPriceUnit` incl./excl. tax per `iface_tax_included`), cart-qty badge, favorite ordering (`is_favorite`, `pos_sequence`), optional grouping by category (`iface_group_by_categ`), 100-product display cap, long-press → ProductInfoPopup (stock by location, margin, order margins, taxes, suppliers — data from server RPC `get_product_info_pos`, with local tax/margin computation).
  - **BarcodeVideoScanner** (camera-based scanning using zxing, `facingMode: environment`) toggled via navbar scan button (`pos.scanning`).
- Product click flow (`pos.addLineToCurrentOrder` → `addLineToOrder`):
  1. Refund-order guard (can't add positive lines to a refund order).
  2. **Product configurator** (`ProductConfiguratorPopup`) if template is configurable (attributes: radio/pills/select/color/multi, custom values, price_extra per value, exclusions via `product.template.attribute.exclusion`, dynamic-variant creation on the server `create_product_variant_from_pos`).
  3. **Combo configurator** (`ComboConfiguratorPopup`) for combo products; `computeComboItems` splits the combo price across children (free vs extra items, qty_free, attribute extras).
  4. **Lot/serial popup** (`SelectLotPopup`) for tracked products — existing lots fetched via `pos.order.line.get_existing_lots`, FIFO/LIFO auto-pick, availability checks vs other draft orders, creation allowed per picking type flags; barcode-embedded lots skip the popup.
  5. **ScaleScreen** for `to_weight` products when `iface_electronic_scale`.
  6. Price computation (pricelist `getPrice`), line creation, **auto-merge** with an existing compatible line (`canBeMergedWith`: same product/discount/price-type/note/uom groupable/not-tracked/not-refund/not-combo).
  7. **OptionalProductPopup** if the product has `pos_optional_product_ids` (cross-sell suggestions).
- Barcode handling on this screen (`useBarcodeReader`): `product` (also `quantity`/`weight`/`price` rule types set qty/price via `setOptions(code)`), `client` (set partner), `discount` (apply % to last line), `lot`, `gs1` (product+lot+quantity composite), packaging barcodes (`product.uom` barcode → qty multiplier), leading-zero-stripped GTIN fallback, on-miss server product load by barcode; beep/error sounds.
- Sample-data loader for empty demo DBs (`loadSampleData`, admin only).

### 1.4 PaymentScreen (`app/screens/payment_screen/`)
- Route: `/pos/ui/<config>/payment/{orderUuid}`.
- UI: list of payment methods (sorted by sequence, with images / cash / pay-later icons and, when cash rounding applies, the pre-formatted rounded amount to charge), **PaymentScreenPaymentLines** (each line: method, amount — editable via numpad when selected, electronic-payment status widget `PaymentScreenStatus` with Send/Cancel/Retry/Reverse/Force-done actions), summary (total, remaining, change), numpad with `+10/+20/+50` quick-add keys, and toggles/buttons: **Invoice** toggle, **Tip** (add/change tip popup), **Ship Later** date picker (`DatePickerPopup`), **Open cashbox**, Customer selection.
- Behaviors:
  - Auto-adds the single configured payment method if only one exists.
  - Selecting a method adds a payment line pre-filled with the remaining due (rounded per cash-rounding config, `getDefaultAmountDueToPayIn`).
  - **Split payments**: multiple payment lines, each editable; numpad edits the selected line; entering an amount beyond due is only allowed when a cash method exists (else "maximum value" error); deleting a line with an in-flight terminal payment sends a cancel to the terminal first.
  - **Electronic terminals** (`payment_interface.js` + `register_payment_method`): status machine `pending → waiting/waitingCard → done/retry/waitingCancel/reversing/reversed/force_done`; `auto_validate_terminal_payment` auto-validates when fully paid; refund orders don't auto-send; reversal support flag.
  - **QR-code payment methods** (`payment_method_type === "qr_code"`): `pos.showQR` fetches a QR from the server (`pos.payment.method.get_qr_code`, fallback `default_qr`), shows `QRPopup` (also mirrored on the customer display), confirm/cancel resolves the payment.
  - Refund orders: invoice toggle auto-set if original order was invoiced.
  - Payments belonging to methods no longer in the config are dropped on mount.
- **Validation** (`app/utils/order_payment_validation.js`, `OrderPaymentValidation`):
  - Pre-checks: customer required for split payments/invoice/shipping/preset requirements; cash rounding correctly applied on cash lines; empty-order rules; missing lot confirmation; "no cash method → exact amount" check; large-overpay confirmation (paid > 1000× total); removes zero/pending payment lines and zero-qty lines.
  - Finalize: opens the cash drawer for cash/change, sets `date_order`, `state = "paid"`, marks the uuid in `localUnsyncedPaidOrderUuids` (data-loss guard), syncs via `syncAllOrders({throw:true})`; downloads invoice PDF if `to_invoice` (`account_move` service); prints stock reports if picking type requests it; sends order to preparation printers; auto-prints receipt if `iface_print_auto`; navigates to ReceiptScreen or FeedbackScreen (`iface_print_skip_screen`), where finalization can continue in the background (`waitFor`).
  - On `ConnectionLostError`: immediately flushes IndexedDB (bypassing the 300ms debounce) and continues to receipt — **paying works offline**.

### 1.5 ReceiptScreen (`app/screens/receipt_screen/`)
- Route: `/pos/ui/<config>/receipt/{orderUuid}`.
- UI: rendered `OrderReceipt`, total (+tip breakdown), buttons: **Print full receipt**, **Print basic receipt** (if `basic_receipt` config; no tax details/prices detail), **Send by email** (input prefilled from partner; renders the receipt to JPEG via `renderer.toJpeg` and calls `pos.order.action_send_receipt` — requires the order to be synced), phone input hook (`showPhoneInput`, disabled in community), **New Order** (→ `orderDone`: clears screen data, opens/creates empty order).
- `nb_print` counter persisted per order; `canEditPayment` only if never printed.

### 1.6 FeedbackScreen (`app/screens/feedback_screen/`)
- Route `/pos/ui/<config>/resume/{orderUuid}`. Shown instead of ReceiptScreen when auto-print + skip-screen is configured: big animated "order done" amount, waits for background finalization (`waitFor` promise), auto-advances to a new order after 5s or on click.

### 1.7 TicketScreen (orders list) (`app/screens/ticket_screen/`)
- Route: `/pos/ui/<config>/ticket`. Two panes (list + detail; mobile pane switch).
- Filters (`SearchBar` with filter dropdown): **Active** (all open), **Ongoing / Payment / Receipt** (mapped from each order's stored screen), **Paid (SYNCED)** (server-fetched, paginated).
- Search fields: Reference (tracking number/floating name), Receipt Number (`pos_reference`), Invoice Number, Date (parsed local → UTC), Customer, Cardholder Name (when terminals exist). Local filtering uses `fuzzyLookup`; SYNCED filter builds an ilike domain and calls `pos.order.search_paid_order_ids` (with config_id, limit/offset; page size adjustable via NumberPopup, default 30), then `read_pos_orders` for uncached/outdated ids.
- Preset filter chips (per `pos.preset`), preset-time color coding (late/warning).
- Order rows: date ("Today"/formatted), reference, tracking, partner, cardholder, employee, total, status; delete button (with confirmation; hidden for finalized orders or completed electronic payments); double-click/select to load an unpaid order back onto its screen; **New Order** button; QR scan of a receipt (camera) to find an order by uuid (`order_uuid` param in the QR URL).
- Detail pane for a synced (paid) order: read-only `OrderDisplay` of lines, **Refund numpad** (Qty only), **InvoiceButton** (invoice or reprint invoice — see §2.11), **Print receipt** (reprint), "Reprint kitchen changes" (`onClickReprintAll`).
- **Refund flow** (see §2.12 for details): select lines & quantities → "Refund" button → creates a negative-qty destination order linked via `refunded_orderline_id` → jumps to PaymentScreen.

### 1.8 PartnerList (customer list — a Dialog, not a page) (`app/screens/partner_list/`)
- Opened from Customer button / payment screen. Shows loaded partners (receivable-account filtered), search-as-you-type over local `searchString`, ILIKE-style `%` wildcards, phone/email-aware server search field selection (`phone_mobile_search`, `barcode`, `vat`, `zip`, `complete_name`, ...), infinite scroll paging via `res.partner.get_new_partner` (offset cache in `pos.screenState.partnerList.offsetBySearch`), Enter = server search.
- `PartnerLine` rows: name, contact info, edit (pencil) button, "orders" shortcut (jumps to TicketScreen filtered by that partner).
- **Create/edit customer**: opens the backend form view in a dialog (`res_partner_action_edit_pos` via `makeActionAwaitable`) — requires network; new record is read back into the local store.
- Selecting a partner: sets `order.partner_id`, recomputes pricelist & fiscal position from partner (`updatePricelistAndFiscalPosition`), auto-enables invoicing for companies (`partner.is_company`). Changing customer is blocked on orders that already contain refund lines.

### 1.9 ScaleScreen (`app/screens/scale_screen/`)
- Dialog opened when weighing a product: shows product name, live weight (polled from hw_proxy `scale_read` every 500ms), tare button, unit price and computed total; confirm returns net weight as line qty. LNE compliance: weight must change between consecutive weighings.

### 1.10 SaverScreen (`app/screens/saver_screen/`)
- Route `/pos/ui/<config>/saver`: screensaver after 5 min idle (2 min on login screen); any interaction returns to the first page.

### 1.11 ActionScreen (`app/screens/action_screen.js`)
- Generic named "action" page (`ActionScreen` with `actionName`) used by other modules (e.g. restaurant floor).

### 1.12 Navbar (`app/components/navbar/`)
- Left: back-to-register / order navigation, `OrderTabs` (floating orders tabs with names/tracking numbers, add-order button).
- Center/right: cashier name/avatar (`CashierName`), **ProxyStatus** (IoT box connection health per driver), sync status indicator & **SyncPopup** (lists pending unsynced operations, allows forcing a data reload — `reloadData(fullReload)` resets IndexedDB and reloads the page, optionally with `limited_loading=0` to load everything), offline banner (`data.network.offline`), **Cash In/Out** (§2.13), **SaleDetailsButton** (prints the session sales report to the proxy printer via backend-rendered `SaleDetailsReport`), close-session entry (§1.13), customer-display opener (window or QR/URL for a remote device), scan-with-camera toggle, product-creation shortcut (backend form dialog), "Reload data" menu, LNA (Local Network Access) permission popup/printer test, PWA install link (`/scoped_app?...` scoped-app URL when not standalone), debug widget toggle in dev mode.
- Global keyboard→search capture: typing anywhere focuses the product search input (barcode-aware buffering using `barcodeService.maxTimeBetweenKeysInMs`).

### 1.13 Closing popup (`components/popups/closing_popup/` — `ClosePosPopup`)
- Data from `pos.session.get_closing_control_data` (orders count/amount, opening notes, expected cash, per-method totals, cash moves list, `amount_authorized_diff`, `is_manager`).
- UI: expected vs counted per payment method (cash counted via manual input or `MoneyDetailsPopup` denomination counting; bank methods pre-filled and auto-fillable), difference display, closing note, cash in/out shortcut, orders-for-future-days warning, "Download sales report" (backend PDF report `sale_details_report`).
- Confirm: difference-tolerance check (manager override / authorized diff / confirmation dialogs), then: sync pending orders (`pushOrdersWithClosingPopup`), `post_closing_cash_details`, `update_closing_control_state_session`, `close_session_from_ui` (with bank diffs and `device_identifier`); errors route to review/cancel-orders dialog or backend session form; on success redirects to `/pos/ui/<config>` (fresh start).
- Other devices on the same session get a `CLOSING_SESSION` websocket notification: they sync their paid orders, mark drafts cancelled, and reload.

### 1.14 Popups inventory (`app/components/popups/`)
`CashMovePopup` (+`CashMoveListPopup`, `CashMoveReceipt`), `ClosePosPopup`, `ComboConfiguratorPopup`, `ConfirmationDialog` wrapper, `DatePickerPopup`, `MoneyDetailsPopup`, `NumberPopup` (numpad dialog used everywhere), `OpeningControlPopup`, `OptionalProductPopup`, `PresetSlotsPopup` (time-slot picker for presets with availability from server usage), `ProductConfiguratorPopup`, `ProductInfoPopup`, `QRPopup` (payment QR), `RetryPrintPopup` (failed prep prints with retry), `SelectLotPopup`, `SelectionPopup` (generic list select), `SyncPopup`, `TextInputPopup`, `TourSelectorPopup`. Generic components: `AccordionItem`, `Input`/`NumericInput` (t-model style inputs), `ListContainer`, `CenteredIcon`, `PriceFormatter`, `ProductInfoBanner` (stock/price banner on product screen), `payment_method_breakdown`, `validation_animation`.

---

## 2. Core client features

### 2.1 Product search & barcode scanning
- In-memory search on normalized concatenated `searchString`; server fallback search paginated by 30 (Enter key); category-scoped search; result capped at 100 items for rendering.
- Barcode sources: (a) HID keyboard wedge via `barcodeService` (keystroke timing based), (b) camera via `BarcodeVideoScanner`/zxing, (c) IoT proxy scanner long-poll (`hw_proxy/scanner`, `iface_scan_via_proxy`).
- Nomenclature parsing (`BarcodeParser`, incl. GS1 with fallback nomenclature): rule types handled: `product`, `quantity`, `weight`, `price`, `client`, `discount`, `lot`, `gs1` composites; packaging barcodes via `product.uom.barcode`; padded-GTIN zero-strip fallback; unknown-barcode notification + error sound.

### 2.2 Price computation
- **Pricelists** (`product_template_accounting.getPrice` + `product_pricelist.js` rule indexes): rule resolution order variant → template → category (incl. parents) → global; `min_quantity` best-rule selection; bases: list price / standard price / other pricelist (recursive); compute types: fixed / percentage / formula (discount %, rounding, surcharge, min/max margin); pricelist↔POS currency conversion; per-order pricelist switch recomputes all non-manual lines (incl. combos re-split).
- **Taxes**: full port of the accounting engine (`@account/helpers/account_tax`: `prepare_base_line_for_taxes_computation`, `add_tax_details_in_base_lines`, `round_base_lines_tax_details`, `get_tax_totals_summary`) — price-included/excluded taxes, groups, rounding modes identical to backend. Order-level lazy price cache (`_prices` with dirty flag) recomputed once per mutation batch; per-line `baseLineByLineUuids` detail; "no-discount" parallel computation to display discount amounts and strike-through prices.
- **Fiscal positions**: `account.fiscal.position.getTaxesAfterFiscalPosition` (tax mapping); source: config default, partner's FP (if allowed in config), preset FP, or manual selection; drives both order pricing and product info display.
- **Discounts**: per-line percentage 0–100 (numpad `%` mode, applied to combo children too), pricelist "without_discount" display policy heuristics (shows original price + implied discount), `getTotalDiscount` aggregate; global-discount product hook (`discountLines` / `globalDiscountPc`, used by pos_discount module).
- **Cash rounding** (`account.cash.rounding` model with `round`/`asymmetricRound`): cash-only or global rounding; affects `remainingDue`, `change`, `appliedRounding`, default payment amounts, and validation checks.
- **Decimal precision**: `decimal.precision` records (Product Price / Product Unit) used for qty & price rounding, zero checks; uom-based qty rounding (`uom.uom.round`).

### 2.3 Numpad behaviors
- Modes: quantity / discount / price (ProductScreen), amount (PaymentScreen with +10/+20/+50), qty-only refund mode (TicketScreen).
- `NumberBuffer` singleton: per-screen holder stack, keyboard+on-screen unified, barcode-safe buffering (delays handling by scanner inter-key time to avoid capturing scans), decimal-point localization, `-` sign toggling (negates current qty/discount/price on first press), Backspace erase / hold-to-remove-line (empty buffer → "remove"), 12-digit cap with bell sound, `capture()` to flush before validation.
- Guards: tip lines cannot be modified (only removed); refund lines qty constrained to remaining refundable (negative only); combo children edit parent; hooks `disallowLineQuantityChange` / `restrictLineDiscountChange` / `restrictLinePriceChange` open NumberPopup flows instead (used by overrides); reduced-below-saved-quantity creates a compensating negative line (restaurant kitchens).

### 2.4 Order line operations
- Create/merge/split as in §1.3; setQuantity (uom-rounded, price recompute unless manual/keep, combo ratio propagation, refund caps), setDiscount (clamped 0–100), setUnitPrice (price precision rounding, `price_type` original/manual/automatic), price_extra from attributes, customer note & internal note (JSON array of tagged notes; note buttons with configured quick-tags), lot/serial editing per line, full product name construction with attributes, per-line tax-group labels, `refundedQty` tracking, `canBeRemoved` when qty zero, tip line detection.
- Order-level: partner set/unset, fiscal position, pricelist, presets (`pos.preset`: pricelist/FP override, timing slots, identification requirements — name/partner/address, `is_return` presets force negative quantities), general customer note, internal note, shipping date (ship-later), to_invoice flag, tracking number & pos_reference generation (device-scoped sequence: `YY<deviceId>-<configId>-<seq>` via `DeviceIdentifierSequence` persisted in localStorage with unused-number recycling), access_token (uuid4) & 5-char ticket_code for the self-service receipt portal.

### 2.5 Customer selection/creation
See §1.8. Also: partner barcode assignment, invoice emails field preference on receipt email, per-partner pricelist/FP application, "can't change customer on refund order" rule, split-payment/invoice/preset flows force customer selection during validation.

### 2.6 Payments
See §1.4. Payment methods: cash (`is_cash_count`, opens drawer, change allowed), bank/card, pay_later (customer account; requires partner via `split_transactions`), terminal-integrated (interface registry), QR-code type. Change = overpay on cash, rounded per config; `amountPaid` excludes change lines (`is_change`). One payment per method type constraints are minimal in community (single cash line expected from v19).

### 2.7 Tipping
`pos.setTip(amount)`: adds/updates a line with the configured `tip_product_id`, sets `is_tipped`/`tip_amount`. PaymentScreen "Add Tip" popup suggests converting current change into a tip; adds the tip difference onto the selected (non-electronic or pending) payment line. Receipt shows total + tip breakdown. `TipScreen` uiState stub exists for restaurant module (adjust after payment).

### 2.8 Invoicing from POS
- At sale time: invoice toggle (requires `invoice_journal_id`), partner required, invoice generated server-side during `sync_from_ui`; PDF auto-downloaded after sync (`account_move.downloadPdf`).
- After sale (TicketScreen `InvoiceButton`): pick partner if missing (writes partner to order), `pos.order.action_pos_order_invoice`, then download; "Reprint Invoice" re-downloads for already-invoiced orders. Refunds of invoiced orders auto-set to_invoice.

### 2.9 Receipts (content & printing)
- **Content** (`order_receipt.xml` + `receipt_header`): company logo (pre-cached as data-URL for offline printing), company address/phone/email/website/VAT (label per country), custom `receipt_header`, cashier ("Served by"), order lines (product, qty×unit price, discounts w/ strike-through original price, attributes, combo children indented, lot/SN numbers, customer notes, tax-group labels per line), subtotal/tax-group breakdown (base+amount per group), cash rounding line, total, payment lines (excluding change) + change, total discount summary, tracking number (big for restaurant), date, `pos_reference`, ticket QR code (self-service portal `/pos/ticket/validate?access_token=...` when `point_of_sale_use_ticket_qr_code`), portal URL/QR per company display mode, payment terminal ticket text (`payment.ticket`), shipping date, `receipt_footer`, basic-receipt variant (skips prices/taxes details).
- **Printing pipeline**: OWL component → off-screen DOM (`render_service.toHtml`) → wait for fonts (Lato/Inconsolata) & images → `html-to-image` canvas (`htmlToCanvas`) → per-printer processing:
  - `HWPrinter` (IoT box / hw_proxy): JPEG base64 → `POST <proxy>/hw_proxy/default_printer_action {action: "print_receipt"}`.
  - `EpsonPrinter` (ePOS network printer, `epson_printer_ip`): canvas → monochrome raster via Floyd–Steinberg dithering → base64 → ePOS-Print XML (`epos_templates.xml` ePOSLayout) POSTed to `http(s)://<ip>/cgi-bin/epos/service.cgi?devid=local_printer`; parses response success/code/status bits (paper out / cover open / almost-out warning); LNA (Local Network Access) `targetAddressSpace` support for Chrome private-network access.
  - **Web fallback**: `window.print()` when no device printer (`webPrintFallback: true` default for receipts).
- Retry dialog on failure with per-printer error messages; `nb_print` persisted; auto-print via `iface_print_auto`; basic receipt option; cash-move receipts; sales-details report printing.
- **Preparation/kitchen printing** (community supports it without restaurant): `pos.printer` records (each ePOS or proxy printer + product category filter). `getOrderChanges`/`changesToOrder` diff current lines vs `last_order_preparation_change` snapshot (new / cancelled / note-updates, combos kept with parents, grouped courses), rendered via `OrderChangeReceipt` template (NEW/CANCELLED/NOTE UPDATE sections, preset name/time, notes); reprint support; conflict check against server copy (`get_preparation_change` — warns "Order Outdated" if another device already sent changes); prints even offline; syncs after print so other devices don't duplicate prints.

### 2.10 Cash in / out
`CashMovePopup`: in/out toggle, amount (mobile numpad dialog), mandatory reason → `pos.session.try_cash_in_out` (queued when offline via `queue=true`), employee log message, prints a `CashMoveReceipt` through the receipt printer, cash-move list popup (`get_cash_in_out_list`). Opens the cash drawer. Cash moves feed into the closing control expected-cash computation.

### 2.11 Orders list & filtering
See §1.7 (filters, search fields, pagination, server fetch, preset filter, reprint, invoice, delete with prep-cancel + `action_pos_order_cancel`).

### 2.12 Refund flow (linked to original order)
- Entry: ControlButtons "Refund" or TicketScreen SYNCED order selection. Per-line refund quantities typed on the qty numpad create `PosOrderLineRefund` details in the **original** order's `uiState.lineToRefund` (keyed by original line uuid; capped at qty − already `refundedQty`; combo refunds propagate proportionally to children; sole-item orders auto-select qty 1).
- "Refund" builds/reuses an empty destination order (same partner preferred): negative-qty lines copying price/discount/taxes/attributes with `refunded_orderline_id` links, lot selection limited to not-yet-refunded lots, combo child links reconstructed, fiscal position copied (with "fiscal position not loaded" guard), `destinationOrder.is_refund = true`, `refunded_order_id` set → straight to PaymentScreen.
- Refund orders: block adding positive lines ("validate the refund before taking another order"), block qty/discount/price edits, terminal refunds don't auto-send/reverse, `document sign = -1` in tax computation. After sync, server links `refund_orderline_ids` back; refunded details cleaned from `lineToRefund` when the refund is paid.

### 2.13 Presets & misc
- `pos.preset`: order modes (e.g. dine-in/takeaway/delivery) with per-preset pricelist/fiscal position, timing slots (`PresetSlotsPopup`, availability computed from server `get_available_slots` usage or locally offline), partner/name/address requirements, return presets.
- Floating orders: multiple parallel draft orders with tabs, names (`floating_order_name`) and tracking numbers; "Save order for later".
- Sale details report; margin/cost visibility in product info; employee action logging (`log_partner_message`); multi-tab guard (localStorage broadcast closes older tabs of the same session); "trusted config" order sharing (orders visible/payable across configs — `getServerOrdersDomain` includes `trusted_config_ids`, `isShareable`).

---

## 3. Offline architecture

### 3.1 Initial data load & local cache
- Server data: `pos.session.load_data_params` (fields+relations metadata per model, cached in localStorage `pos_data_params_<configId>`) then `pos.session.load_data` (all model records; supports **limited loading** — trimmed product/partner set — with `?limited_loading=0` escape hatch, and **incremental loading** via `pos_last_server_date` when the local cache is fresh).
- **IndexedDB** (`app/models/utils/indexed_db.js` + data_service): DB name `point-of-sale-<configId>-<db>`; one object store per model; keyPath `id` for server ("static") models, `uuid` for frontend-created ("dynamic") models (`pos.order`, `pos.order.line`, `pos.payment`, `pos.pack.operation.lot`, `product.attribute.custom.value` — see `data_service_options.js`). Features: batch writes (500/transaction, 5s timeouts), auto schema upgrade when stores are missing, iOS "IDB server lost" reload dialog, visibility-change probe to reconnect stale connections, full reset on config-change (`odoo.last_data_change` vs cached `_data_server_date`).
- Static server data is mirrored into IndexedDB after load and on every record update/delete event; dynamic models are flushed by a **300ms-debounced snapshot** (`synchronizeLocalDataInIndexedDB`) that persists all not-yet-removable records (an order stays until it is finalized **and** synced, or cancelled) and garbage-collects the rest.
- On boot: cached static data is loaded first (offline boot works if the session was already open — `session.state === "opened"` short-circuits the network load), then draft/unsynced orders are rehydrated from IndexedDB (`getLocalDataFromIndexedDB`), missing referenced records are recursively fetched (`missingRecursive`), orders whose products aren't loadable are filtered, and orders deleted server-side are locally purged (`checkAndDeleteMissingOrders`).

### 3.2 Connectivity model
- `data.network` reactive: `{offline, loading, warningTriggered, unsyncData[]}`. Browser online/offline events + active ping `/pos/ping`; while `navigator.onLine` but server unreachable, retry every 2s. `pos-network-online` window event triggers order sync on recovery.
- Every ORM access goes through `PosData.execute({type, model, ...})`, which throws `ConnectionLostError` when offline; calls flagged `queue=true` (e.g. cash in/out, opening control) are appended to `network.unsyncData` with a uuid and **replayed in order** (`syncData`, mutex-protected) when connectivity returns. `sync_from_ui` (order sync) is deliberately *not* queued there — orders are the pending-order mechanism instead.

### 3.3 Order sync & uuid/conflict handling
- Orders/lines/payments are created client-side with **uuid** primary keys (uuid4); server ids arrive after sync (`isSynced` = numeric id). `serializeForORM` emits ORM create/update commands plus `relations_uuid_mapping` so the backend can relink new child records by uuid; `sync_from_ui` is idempotent by uuid (safe re-push).
- Pending queue: `pos.pendingOrder = {create:Set, write:Set, delete:Set}`; orders are pushed **one by one** (`syncAllOrders`, debounced wrapper, mutex for single pushes, per-order `syncingOrders` lock) with context `{config_id, device_identifier, current_order_uuid}`; prices are materialized (`setOrderPrices`) before sending; response data (order, session, refund links, missing records) is merged back into the store. Failures: ConnectionLost → keep pending & retry later; other errors → re-read server state via `deviceSync.readDataFromServer()` (server wins). A "rescue session" returned by the server transparently replaces a closed session.
- Unsynced-paid safety: `localUnsyncedPaidOrderUuids` + IndexedDB verification + `beforeunload` warning; paid-but-unsynced orders re-enter the pending queue on every boot (`afterProcessServerData`).
- **Multi-device sync** (`app/utils/devices_synchronisation.js`): websocket channel `SYNCHRONISATION`; on writes to static models each device notifies others (`pos.config.notify_synchronisation` with device identifier to avoid echo); receivers pull deltas via `read_config_open_orders` (open orders with `write_date`/state domains, deleted-record ids, missing records) and merge; per-device order-number namespaces (`DeviceIdentifierSequence`, id + sequence in localStorage) prevent reference collisions; kitchen-change timestamp comparison prevents duplicate/preparation conflicts ("Order Outdated" dialog).
- Session closing from another device broadcast on channel `CLOSING_SESSION`.

### 3.4 What works offline vs requires network
- **Works offline**: full selling flow (browse/search loaded products, all line ops, local customers, taxes/pricelists/fiscal positions — all computed client-side), payment with non-terminal methods, order validation (order stays queued), receipt printing to LAN ePOS/IoT printers and web print, kitchen tickets, local order list, boot from cache (if session already opened), preset slot estimation (local fallback), barcode scan of loaded products.
- **Requires network**: initial session open/opening control, product/partner *server* search & creation/edit (backend form views), invoicing & invoice PDF, receipt email, QR payment generation (falls back to static `default_qr`), payment terminals (their own connectivity), refund of orders not in cache, SYNCED order list fetch, lot existence check (bypassable with confirmation), session closing, cash in/out (queued), sample data, product info popup (server part), customer display via server bus (local BroadcastChannel path still works).

---

## 4. Hardware integrations (community code)

1. **IoT Box / hw_proxy** (`hardware_proxy_service.js`): discovery via `force_ip`/`localStorage.hw_proxy_url`, `hello` availability probe (3 retries, 1s timeout), `handshake`, 5s `status_json` keep-alive with per-driver status (shown in `ProxyStatus`); generic `message(name, params)` RPC.
2. **Barcode scanner**: HID wedge (global service), proxy scanner long-poll (`message("scanner")` loop when `iface_scan_via_proxy`), camera scanner (zxing).
3. **Receipt printers**: `HWPrinter` (via proxy) and `EpsonPrinter` (direct ePOS XML with dithering) — see §2.9; per-category preparation printers (`pos.printer` model, `printer_type: epson_epos` or proxy); backend "test ePOS" utility (`backend/test_epos`). LNA/private-network-access handling (`init_lna.js`, permission state surfaced in navbar).
4. **Cash drawer**: `openCashbox()` on the active printer — ePOS `<pulse>` or proxy `{action:"cashbox"}`; triggered on cash payment validation, cash in/out, opening/closing counts (gated by `iface_cashdrawer`); each manual open logged (`logEmployeeMessage` "CASH_DRAWER_ACTION").
5. **Customer display** (`customer_display/` standalone app + `app/customer_display/` adapter):
   - Standalone OWL app served at `/pos_customer_display/<configId>/<deviceUuid>?access_token=...` — shows order lines (qty, price, discounts, notes, combos, lots), totals/taxes/change, payment lines, payment QR overlay, scale weighing data, idle Odoo logo.
   - Data path: same-machine window via `BroadcastChannel("UPDATE_CUSTOMER_DISPLAY")`; remote device via server RPC `pos.config.update_customer_display` + bus channel `UPDATE_CUSTOMER_DISPLAY-<device_uuid>`; IoT proxy variant polls `hw_proxy/customer_facing_display` every second. Pushed reactively from `Chrome` on every order change.
6. **Electronic scale**: `pos_scale` service via proxy `scale_read` (continuous 500ms polling), tare, LNE weight-change rule, ScaleScreen UI; `iface_electronic_scale` config; community assumes automatic measurement (no manual mode).
7. **Payment terminals**: abstract `PaymentInterface` only (implementations live in separate modules — e.g. Adyen/Stripe/Six); registration hook `register_payment_method`; `iot_longpolling` service dependency present for IoT-based terminals.

---

## 5. Real-time / bus usage

- Transport: Odoo `bus_service` websocket; POS subscribes with `getOnNotified(bus, odoo.access_token)` (channels are access-token scoped). Reconnect logic re-subscribes all channels on `BUS:CONNECT`.
- Channels/notifications consumed by the register app:
  - `SYNCHRONISATION` — other-device change notifications (static record ids + trigger to re-read open orders/deleted ids). Drives shared-order/multi-device consistency.
  - `CLOSING_SESSION` — a device started closing the session; others sync & reload.
- Customer display consumes `UPDATE_CUSTOMER_DISPLAY-<device_uuid>` (full formatted order payload pushed by the register through the server) — plus the non-bus `BroadcastChannel` local path.
- Outbound realtime triggers: `notify_synchronisation` after local writes to shared/static models; `update_customer_display` on order mutations.
- No other longpolling in community except `iot_longpolling` (service dependency for IoT modules) and hw_proxy scanner long-poll (HTTP, not bus).

---

## 6. PWA-relevant pieces

- **Service worker**: `app/service_worker.js`, served at `/pos/service-worker.js`, registered in `main.js`. Strategy: *network-first with cache fallback* for all GET requests into cache `odoo-pos-cache`; explicitly skips `web/dataset` RPCs (data lives in IndexedDB), extensions, `hw_proxy/hello`, Cashdro; pre-caches an explicit URL list posted via `postMessage` (`odoo.urls_to_cache` injected server-side + zxing library) — i.e., asset bundles are pre-warmed so the app shell boots offline.
- **Installable scoped app**: navbar exposes `/scoped_app?app_id=point_of_sale&app_name=...&path=pos/ui/<configId>` (Odoo's scoped-PWA mechanism supplies the manifest); `isDisplayStandalone()` detection hides the install link when already installed.
- **Offline data**: IndexedDB (see §3) + localStorage (`pos_data_params_*`, device identifier/sequence, `hw_proxy_url`, `device_uuid`, cashier in sessionStorage, multi-tab `message` key).
- **Unload protection**: `beforeunload` confirmations (offline / unsynced paid orders), opening-control session cleanup beacon, reload-recovery flag in sessionStorage.
- Fonts (Lato, Inconsolata) explicitly awaited before printing; receipt logo cached as data URL for offline receipts.

---

## 7. React rebuild — parity checklist highlights (non-obvious behaviors)

1. Client-side tax engine must match the backend to the cent (reuse of `account_tax` helpers incl. rounding modes, price-included taxes, cash rounding, document sign for refunds).
2. Uuid-first data model with ORM-command serialization + `relations_uuid_mapping`; idempotent one-by-one order sync; per-device reference sequences; dirty tracking; lazy price-cache invalidation on line/order field events.
3. Dual persistence semantics: static models keyed by id vs dynamic models keyed by uuid; retention rule "keep until finalized+synced or cancelled"; debounced flush **with immediate flush on offline payment**.
4. NumberBuffer subtleties: barcode-scanner debouncing, buffer-holder stack per screen, `Backspace → remove line`, sign toggling, start-over states.
5. Screen-per-order restoration (`uiState.screen_data`), floating orders/tabs, mobile pane switching.
6. Refund bookkeeping lives on the *original* order (`uiState.lineToRefund`) and constrains destination-order line quantities.
7. Print pipeline is image-based (HTML→canvas→JPEG/raster), with Epson dithering, warning status bits, retry popups, and per-category kitchen diffs with cross-device conflict detection.
8. Multi-device flows: websocket delta sync, closing-session broadcast, multi-tab kill switch, trusted-config order sharing.
9. Extensibility hooks used heavily by other modules (restaurant, loyalty, hr, l10n): `pos_pages` registry, `pos_available_models` registry, `register_payment_method`, overridable `PosStore`/`OrderPaymentValidation`/`TicketScreen` methods — plan equivalent extension points.
