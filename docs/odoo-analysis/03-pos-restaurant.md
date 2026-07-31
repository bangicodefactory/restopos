# Odoo 19 `pos_restaurant` — Full Feature Inventory (for Laravel + React migration)

Source analyzed: `/home/claude/odoo19/addons/pos_restaurant` (branch 19.0) plus the parts of
`/home/claude/odoo19/addons/point_of_sale` that the restaurant flow depends on (preparation
printers, order-change delta engine, tips, notes). Community repo tree was also enumerated to
determine what is community vs enterprise (section 5).

Module manifest (`__manifest__.py`): depends only on `point_of_sale`, is an `application`,
loads all of `static/src/**/*` into the POS asset bundle plus `restaurant.scss` after
`pos.scss`. Backend data: security CSV, restaurant presets, order/preset/config views.

---

## 1. Data model additions

### 1.1 New model: `restaurant.floor` (`models/pos_restaurant.py`)

| Field | Type | Notes |
|---|---|---|
| `name` | Char, required | Floor name |
| `pos_config_ids` | Many2many → `pos.config` | Domain: configs with `module_pos_restaurant = True`. A floor can be shared by several POS configs |
| `background_image` | Binary | Legacy field (not loaded to UI) |
| `floor_background_image` | Image | The background image actually used by the floor plan UI |
| `background_color` | Char | HTML color; UI stores a named key (`white`, `red`, …) mapped to light/dark RGB palettes client-side |
| `table_ids` | One2many → `restaurant.table` (`floor_id`) | |
| `sequence` | Integer, default 1 | Floor ordering (`_order = "sequence, name"`) |
| `active` | Boolean, default True | Soft delete ("deactivate floor") |

Loaded to POS client (fields): `name, background_color, table_ids, sequence, pos_config_ids, floor_background_image, active`; domain `pos_config_ids = config.id`.

Business rules:
- Cannot delete/archive a floor (or change its configs) while any linked config has an open POS session (`_unlink_except_active_pos_session`, `write` override).
- `deactivate_floor(session_id)`: refuses if draft orders exist on the floor's tables; otherwise deactivates the floor and all of its tables.
- `sync_from_ui(name, background_color, config_id)`: creates a floor from the POS UI and links it to the config.
- `rename_floor(new_name)` helper.
- On `pos.config` create/write with `module_pos_restaurant = True` and no floors, a default floor (named after the company) with one table (number 1, 130×130 at 100,100) is auto-created (`_setup_default_floor`).
- Turning off `module_pos_restaurant` clears `floor_ids` on the config.

### 1.2 New model: `restaurant.table`

| Field | Type | Notes |
|---|---|---|
| `floor_id` | Many2one → `restaurant.floor`, indexed | |
| `table_number` | Integer, required, default 0 | Displayed number; used for search-by-number; `display_name = "<floor>, <number>"` |
| `shape` | Selection `square` / `round`, required, default `square` | |
| `position_h` | Float, default 10 | X (px) from left (top-left of the table in practice; UI treats as left edge) |
| `position_v` | Float, default 10 | Y (px) from top |
| `width` | Float, default 50 | px |
| `height` | Float, default 50 | px |
| `seats` | Integer, default 1 | Default number of guests when an order is opened on the table |
| `color` | Char | Any valid CSS `background` value |
| `parent_id` | Many2one → `restaurant.table` | Table linking/merging: child tables snap to a parent; cycle-guarded |
| `active` | Boolean, default True | Soft delete |

Loaded to POS client (fields): `table_number, width, height, position_h, position_v, parent_id, shape, floor_id, color, seats, active`; domain: active tables of the config's floors.

Business rules:
- `are_orders_still_in_draft()`: raises if the tables still have draft orders (used before UI delete).
- Cannot hard-delete tables used by a config with an open session.
- `set_parent_id(parent_id, config_id)`: server-side linking with `_has_cycle('parent_id')` protection; returns re-read table records for broadcast.

### 1.3 New model: `restaurant.order.course` (`models/restaurant_order_course.py`)

| Field | Type | Notes |
|---|---|---|
| `uuid` | Char, readonly, default uuid4 | Client/server sync key (offline-first, IndexedDB keyed on uuid) |
| `index` | Integer, default 0 | Course number (1-based in UI; label "Course N") |
| `fired` | Boolean, default False | Whether the course was fired to the kitchen |
| `fired_date` | Datetime | Auto-set on create/write when `fired` becomes true |
| `order_id` | Many2one → `pos.order`, required, indexed, `ondelete=cascade` | |
| `line_ids` | One2many → `pos.order.line` (`course_id`), readonly | |

Loaded to client with `['uuid','fired','order_id','line_ids','index','write_date']`, domain: courses of loaded orders. Access rights: full CRUD for `group_pos_user` (floors/tables are read-only for users, manager-writable).

### 1.4 Fields added to existing models

`pos.config` (`models/pos_config.py`):
| Field | Type | Notes |
|---|---|---|
| `iface_splitbill` | Boolean | Enables Bill Splitting |
| `iface_printbill` | Boolean | Enables Bill printing before payment (defaults to True when creating a restaurant config) |
| `floor_ids` | Many2many → `restaurant.floor` | `copy=False`; in `_get_forbidden_change_fields` (cannot change while session open) |
| `set_tip_after_payment` | Boolean | Tip adjustment after payment (forced False unless restaurant + `iface_tipproduct`) |
| `default_screen` | Selection `tables` / `register`, default `tables` | Which screen the POS opens on |

Relevant pre-existing core `pos.config` fields the restaurant flow relies on (community `point_of_sale`):
- `module_pos_restaurant` (Boolean "Is a Bar/Restaurant") — master switch.
- `is_order_printer` (Boolean) + `printer_ids` (M2M → `pos.printer`) — preparation/kitchen printers.
- `iface_tipproduct` (Boolean) + `tip_product_id` (M2O product) — tips.
- `note_ids` (M2M → `pos.note`) — predefined internal/kitchen note buttons.
- `order_edit_tracking` (Boolean) — audit of edited orders.

`res.config.settings` (`models/res_config_settings.py`): `pos_floor_ids` (related), `pos_iface_printbill`, `pos_iface_splitbill` (computed from `pos_module_pos_restaurant`), `pos_set_tip_after_payment` (computed from `pos_iface_tipproduct`), `pos_default_screen` (related).

`pos.order` (`models/pos_order.py`):
| Field | Type | Notes |
|---|---|---|
| `table_id` | Many2one → `restaurant.table`, readonly, indexed | Table the order was served at |
| `customer_count` | Integer "Guests", readonly | Guest count |
| `course_ids` | One2many → `restaurant.order.course` | |

Also overrides `_get_open_order`: for restaurant configs a draft order is matched by `uuid` OR (`table_id` + draft + config) — i.e. one active draft order per table is enforced at sync; and `read_pos_data` additionally returns the order's courses.

Core `pos.order` fields the flow depends on: `last_order_preparation_change` (Char/JSON — last state sent to kitchen, with `metadata.serverDate` for multi-device conflict detection; `_ensure_to_keep_last_preparation_change` keeps the newest), `general_customer_note` (Text), `internal_note` (Text), `is_tipped` (Boolean), `tip_amount` (Monetary), `floating_order_name`, `tracking_number`, `nb_print`, `state` (`draft/cancel/paid/done`), `uuid`.

`pos.order.line` (`models/pos_order_line.py`):
| Field | Type | Notes |
|---|---|---|
| `course_id` | Many2one → `restaurant.order.course`, `ondelete='set null'`, indexed | Added to `_load_pos_data_fields` |

Core line fields used: `note` (Char "Product Note" = internal/kitchen note), `customer_note` (Char), `uuid`.

`pos.payment` (`models/pos_payment.py`): no new fields; adds `_update_payment_line_for_tip(tip_amount)` (adds tip to `amount`; hook for terminal modules — `pos_restaurant_adyen` / `pos_restaurant_stripe` override it to capture/adjust on the terminal).

`pos.preset` (`models/pos_preset.py`): adds `use_guest` (Boolean — force guest-count prompt when ordering); loaded to UI; deletion of the three master presets (`pos_takein_preset` Dine In, `pos_takeout_preset` Takeout, `pos_delivery_preset` Delivery — defined in `data/scenarios/restaurant_preset.xml` with an opening-hours `resource.calendar`) is forbidden.

`pos.session` (`models/pos_session.py`): loads the 3 extra models (`restaurant.floor`, `restaurant.table`, `restaurant.order.course`) when `module_pos_restaurant`; `_set_last_order_preparation_change(order_ids)` rebuilds the "everything already sent" snapshot server-side (used e.g. by self-order).

Backend views (`views/*.xml`): floor form/list/kanban/search + table form (list editable inline on floor form), menu "Floor Plans" under POS configuration; `pos.order` form shows `table_id` + `customer_count`; settings view adds Floors & Tables Map, Early Receipt Printing, Allow Bill Splitting, "Add tip after payment" (hidden for BE), Default Screen radio.

---

## 2. Floor plan features (`static/src/app/screens/floor_screen/`)

Registered POS page `FloorScreen` at route `/pos/ui/<config>/floor`. It is the default landing page when `default_screen = 'tables'` (otherwise "register"), and the idle fallback: after 3 min of inactivity the POS navigates back to FloorScreen (unless on Payment/Ticket/Action/Login screens).

### 2.1 Display / navigation
- Floor tab bar listing all active floors of the config; each tab shows a red pill badge with the floor's total unsent-change count (`getFloorChangeCount`).
- Two render styles: positioned map (`default`) and grid list (`kanban`, default on small screens); toggle persisted in `localStorage("floorPlanStyle")`.
- Floor background: named color (client palettes for light/dark mode) or an uploaded background image (base64 → `floor_background_image`, written via ORM then re-read).
- Pinch-to-zoom (CSS `--scale`), per-floor scroll position memory, auto-sized canvas from table extents/背景 image size.
- Table rendering: number centered, border/background from table `color` (default green `#35d374`), round tables via border-radius, `occupied` styling when the table has open orders, `syncing` state, red badge with unsent change count per table (`getChangeCount` → core `getOrderChanges().nbrOfChanges`). *Note: unlike Odoo ≤16, v19 shows no amount / minutes-since-change badge on tables — only the change-count badge and occupied color; `table.uiState.orderCount/changeCount` are also refreshed from a session-closing notification (`computeTableCount`).*
- "New Order" button (direct sale / floating order without table); numpad dropdown (`NumpadDropdown`) to jump to a table by typing its number (`searchOrder`/`findTable`).

### 2.2 Edit mode (in-POS floor designer)
Toggled per-device (`pos.isEditMode`, Escape exits). All edits write straight to the backend via `pos.data.write/create` on `restaurant.floor` / `restaurant.table`:
- Create floor (name popup), rename floor, duplicate floor (copies all its tables), delete floor (= server `deactivate_floor`; blocked when draft orders exist; local open orders on that floor are removed).
- Set floor background color (stores palette key; clears image) or upload image.
- Add table: smart placement algorithm scans existing rectangles for the first free slot (width ≈ 75–130 px scaled to screen), defaults: square, 2 seats, green, grid-snapped; auto-numbered `max(table_number)+1`; auto-scroll to it.
- Multi-select tables (ctrl/meta-click), then: change seats (number popup), toggle shape square/round, set color, rename (change `table_number` via numeric popup), duplicate (offset +10/+10), delete (soft: `active = False`, guarded by `are_orders_still_in_draft`).
- Move: drag & drop with 10-px grid snapping (snap disabled when floor has a background image); kanban style reverts positions on drop.
- Resize: 4 corner drag-handles on selected table, min size 30 px, constrained to the floor, grid-snapped.

### 2.3 Table linking (physical merge) & transfers
- **Linking (drag one table onto another, outside edit mode):** dragging table A over table B for >400 ms suggests a link; child snaps to the nearest side of the parent (`setPositionAsIfLinked` left/right/top/bottom). On drop: any active order on the child is merged into the parent's order (`mergeTableOrders`), and `restaurant.table.set_parent_id` persists the link. Linked children render semi-transparent; clicking a child opens the parent; `rootTable`/`getParent()` walk the chain; order name becomes `T 3 & 4`. Dragging a linked child away unlinks it (`parent_id = null`) and restores the pre-merge lines/courses to a new order on it (`restoreOrdersToOriginalTable`, using `order.uiState.unmerge` / `unmergeCourses` bookkeeping: per-line `{table_id, quantity, formerUuid}` and per-course `{table_id, lines, index, fired, fired_date}`). After an order is paid, all child links of its table are cleared (`afterOrderValidation` in `order_payment_validation.js`).
- **Order transfer (`startTransferOrder` in `pos_store.js`):** "Transfer / Merge" control button puts the UI in transfer mode (sticky warning notification), navigates to FloorScreen; clicking a target table moves the order there (empty target → simple `table_id` reassignment) or **merges** it into the target's active order; from TicketScreen a target *order* row can be picked instead (merge floating orders). Self-transfer is rejected. Merge logic (`_mergeOrders`): sums guest counts, merges mergeable lines (`canBeMergedWith` — must be same course), re-parents courses by matching `index`, migrates the `last_order_preparation_change` entries (`handlePreparationHistory` moves sent-quantities between orders so no spurious kitchen tickets are produced), combines `uiState.lastPrints`, records unmerge info, deletes the source order.
- Guest count of a table = sum over its open orders (`getCustomerCount(tableId)`).

### 2.4 Multi-device sync
`pos.config.isShareable` is true for restaurant configs; orders are pushed (`addPendingOrder`) on every relevant mutation (add line, qty update, partner set, guest count…). `devices_synchronisation.js` patch: after receiving dynamic records, if a table ends up with >1 open order (two waiters raced), the lines of local/duplicate orders are moved onto the oldest synced order and duplicates are deleted. `setTable` triggers `deviceSync.readDataFromServer()`. Multi-device kitchen-ticket conflicts are caught via `last_order_preparation_change.metadata.serverDate` (see 3.3).

---

## 3. Restaurant order flow

### 3.1 Guest count
- New order on a table defaults `customer_count = table.seats` (`createNewOrder` patch); floor default min 1.
- "Guests" control button → NumberPopup with live feedback "amount / Guest" (`amountPerGuest = totalDue / customer_count`); 0 guests on an empty order deletes it.
- Presets with `use_guest = True` force the guest prompt the first time the order button is pressed (`ensureGuestCustomerCount`; falls back to table seats).
- Payment screen shows "X / Guest" splitter hint when >1 guest; receipts print "Table N, Guests: C" in the header; kitchen ticket header shows `Guest: N` and `<floor> - <reference>`; splitting a bill decrements `customer_count` on the original order.
- Stored on `pos.order.customer_count`, shown in backoffice order form.

### 3.2 Courses (new in 19 — yes, present in community)
- "Course" control button (`pos.addCourse()`): creates `restaurant.order.course` records client-side; creating the first course while lines exist assigns all lines to Course 1 and opens an empty Course 2. New lines are attached to the selected (or last) course; combo children follow their parent's course.
- Order display groups lines under course headers (`OrderCourse` component patched into `OrderDisplay`); a course header is clickable to select it; fired courses show a "Fired" tag.
- **Fire course**: the action pad shows a "Fire Course N" primary button when the selected course is ready (`isReadyToFire` = not fired and non-empty). `fireCourse` marks it fired (server stamps `fired_date`), sends the order to preparation with `byPassPrint`, then prints a dedicated ticket "Course N fired" listing the course's products (`printCourseTicket`, a `noteUpdate`-type change with `printNoteUpdateData: false`).
- Ordering normally (`submitOrder`) fires the *first* course implicitly.
- "Transfer course" button: moves the selected line (with its combo children) — or all lines of the selected course — to another course via selection popup.
- `cleanCourses()` (on leaving product screen/order button): deletes trailing empty unfired courses and re-indexes 1..n.
- Kitchen tickets group changed lines by course: `receiptLineGrouper.getGroup` returns `{index, name}` of the line's course, and core `prepareReceiptGroupedData` renders grouped sections sorted by course index. Bill/receipt lines are grouped by course too (same grouper is used by the receipt).
- Course state survives splits/merges/unmerges (course `index` matching, `unmergeCourses`).

### 3.3 Sending to kitchen / preparation printing (community mechanism)
The engine is in **`point_of_sale`** (usable without restaurant, e.g. for bars) and is driven by **`pos.printer`** (`models/pos_printer.py` — the old `restaurant.printer` model, moved to core):
- `pos.printer` fields: `name`, `printer_type` (`iot` = IoT-box proxy | `epson_epos` = direct Epson ePOS), `proxy_ip`, `epson_printer_ip` (with Epson certified-domain derivation from serial), `product_categories_ids` M2M → `pos.category` ("Printed Product Categories" = **category routing**), `company_id`, `pos_config_ids`. Enabled per config via `is_order_printer` + `printer_ids`.
- `config.printerCategories` (frontend getter) = union of all printers' category ids; `preparationCategories` = same set. Only products whose category (or combo parent/child category) is in this set are considered "kitchen items".
- **Delta engine** (`point_of_sale/static/src/app/models/utils/order_change.js`): `getOrderChanges(order, categories)` diffs current lines against `order.last_order_preparation_change.lines` (a `{ uuid+note key → {uuid, name, basic_name, product_id, attribute_value_names, quantity, note, customer_note, pos_categ_id/sequence, combo info, group} }` map). It produces: `orderlines` (qty additions with +qty / removals with −qty, including fully deleted lines), `noteUpdate` (note-only changes), `general_customer_note` / `internal_note` diffs, plus counters `nbrOfChanges` (abs) and `count` (signed). `changesToOrder` splits into `new` / `cancelled` lists.
- **Send flow** (`submitOrder` → `sendOrderInPreparationUpdateLastChange` → `checkPreparationStateAndSentOrderInPreparation` → `sendOrderInPreparation`):
  1. Offline guard (throws ConnectionLost, but printing still attempted when offline).
  2. Multi-device guard: fetch `pos.order.get_preparation_change`; if the server's `metadata.serverDate` differs from the local one, warn "Order Outdated", adopt server state and just sync.
  3. `sendOrderInPreparation`: if there are changes, push them on `order.uiState.lastPrints` and `printChanges`; **per printer**, changes are filtered by that printer's categories (`filterChangeByCategories`, combo lines follow their parent), then split into up to 4 tickets: **NEW**, **CANCELLED**, **NOTE UPDATE**, and a note-only ticket for order-level internal/customer note changes (`generateReceiptsDataToPrint`), each rendered with qweb template `point_of_sale.OrderChangeReceipt` (extended by pos_restaurant to add floor name + guest count) and grouped by course. Failed printers get a Retry popup.
  4. `order.updateLastOrderChange()` snapshots the current lines/notes as the new baseline; order is synced so other devices don't double-print (skipped when a `pos.prep.display` exists — enterprise).
- pos_restaurant additions: success notification "2 Drinks, 1 Food … sent to the kitchen" (`getCategoryCount` — counts per first POS category + Note/Message/preset-mode-change pseudo-entries); order/actionpad buttons show per-category change chips; product screen "Order" button is primary when `nbrOfChanges > 0`; "Reprint" re-sends the last ticket (`explicitReprint` reprints `uiState.lastPrints.at(-1)` even with no changes); paying with unsent changes asks "It seems that the order has not been sent…" (`_askForPreparation`, also hooked into fast payment); orders with a table or courses are always persisted server-side (`shouldCreatePendingOrder`).
- Order-line visual state: lines with unsent changes get class `has-change` (`getDisplayClasses` patch); OrderTabs (floating orders) show a red unsent-change bubble.

### 3.4 Internal notes to kitchen
Core `point_of_sale` (community) feature used heavily by restaurant:
- `pos.order.line.note` ("Product Note" — internal/kitchen), `pos.order.line.customer_note`, `pos.order.internal_note`, `pos.order.general_customer_note`.
- `pos.note` model (name, sequence, color; unique name) + `pos.config.note_ids` = predefined quick-note chips; notes are stored as JSON arrays of `{text, colorIndex}` (see `getStrNotes` parsing).
- Note changes alone trigger a "NOTE UPDATE" kitchen ticket (see delta engine); order-level note changes print a header-only ticket.

### 3.5 Bill printing before payment (`iface_printbill`)
- "Bill" control button → `pos.printReceipt({printBillActionTriggered: true})`: prints the standard receipt via the receipt printer, without incrementing `nb_print`; the receipt template prepends **"Pro forma receipt"** when the order is not finalized (`pos_restaurant.OrderReceipt` xpath).
- When `set_tip_after_payment`, the receipt also appends a gratuity-suggestions block (15/20/25% of `priceIncl`).

### 3.6 Bill splitting (`iface_splitbill`, `SplitBillScreen`)
Registered page at `/pos/ui/<config>/splitting/{orderUuid}`; opened by the "Split" control button (disabled unless ≥2 discountable units).
- Tap lines to move quantities one-by-one into the new bill (tap cycles 0→1→…→max→0); combo lines move as a whole (`getAllLinesInCombo`); running new-order total displayed; per-line `x / y` split badge (`uiState.splitQty` patched into Orderline template).
- **Pay** (`paySplittedOrder`): if a strict subset is selected, `createSplittedOrder()` builds a new order (copies preset, preset_time, fiscal position, pricelist; recreates selected quantities as new lines — combos re-linked, courses re-created by index; original global % discount re-applied) named `<table-number-or-name>B`, `C`, … (max 26 parts); preparation history is migrated per split quantity (`handlePreparationHistory`) so the kitchen isn't re-sent; original order's `customer_count` decremented; both orders synced; then Payment screen opens for the split order. The original order remembers `SplitBillScreen`; after the split bill is paid, ReceiptScreen/FeedbackScreen offer **"continue splitting"** back on the original order (`isContinueSplitting`/`continueSplitting`, linked via `uiState.splittedOrderUuid`).
- **Transfer variant** (`transferSplittedOrder`): split off the selected lines then immediately enter transfer mode to move the new order to another table/order (partial table transfer).
- Split is guarded against double-execution (`uiState.isSplitInProgress`).

### 3.7 Tips (settle / adjust after payment)
Config: `iface_tipproduct` + `tip_product_id` (core) and `set_tip_after_payment` (restaurant).
- Core `pos.setTip(amount)` adds/updates a tip product line and sets `is_tipped`/`tip_amount`.
- With `set_tip_after_payment`: after validating payment, if the first payment line `canBeAdjusted()` (terminal-supported, or any non-cash non-QR method per `pos_payment.js` patch), the flow goes to **TipScreen** (`/pos/ui/<config>/tipping/{orderUuid}`) instead of the receipt. Payment screen buttons relabel to "Close Tab" / "Keep Open".
- **TipScreen**: prints a signature tip receipt on mount (`TipReceipt` component: terminal ticket + Subtotal + blank Tip/Total lines + signature line, for each of ticket/cashier_receipt of the payment line); shows amount, 15/20/25% quick buttons and a custom input; confirmation asked if tip > 25% of total; `validateTip()` temporarily flips order state draft→paid to add the tip line, pushes the tip line to the server, calls `payment_terminal.sendPaymentAdjust(uuid)` (interface added to `PaymentInterface`: `canBeAdjusted`/`sendPaymentAdjust`; actual capture implemented by `pos_restaurant_adyen`/`pos_restaurant_stripe`; server hook `pos.payment._update_payment_line_for_tip`), then writes `is_tipped/tip_amount` and goes to the receipt. "No tip" writes `is_tipped: true, tip_amount: 0`.
- **Settle from TicketScreen**: with `set_tip_after_payment`, ticket list states become OPEN / **TIPPING** (orders whose screen is TipScreen); an inline editable `TipCell` per order lets a manager enter tips in bulk and `settleTips()` applies the same flow for every filtered order.
- Payment lines can also be adjusted pre-close via `sendPaymentAdjust` on the payment screen (difference between total-with-tax and paid).

### 3.8 Order lifecycle particularities (restaurant)
- Order naming: table orders are "T <n>[ & m…]"; table-less draft orders are "Direct Sale" until given a `floating_order_name` (edit popup `EditOrderNamePopup`, which also lists other floating orders to merge into); presets without table force a name (partner name or popup).
- One draft order per table is enforced server-side on sync (`_get_open_order`) and client-side on device sync.
- Book/unbook: an empty table order can be "booked" (kept open without lines) or unbooked (deleted) from the order summary.
- TicketScreen: search by `table_id.table_number`, table column "Floor/Table", selecting a table order re-enters the table context.
- `pos.order` states (core): `draft → paid → done` (+ `cancel`); "sent to kitchen" is *not* a state — it's the `last_order_preparation_change` snapshot.

---

## 4. Kitchen / preparation display in Community 19

Searched the entire community 19.0 addons tree (`git ls-tree origin/19.0 addons/`) and all checked-out code:

- **No preparation-display module exists in community.** There is no `pos_preparation_display`, `pos_prep_display`, or `pos_enterprise` addon in the community repository. (In Odoo 19 the Kitchen/Preparation Display lives in the **enterprise** repo — `pos_enterprise` provides the `pos.prep.*` models — with self-order integration in enterprise `pos_self_order_preparation_display`.)
- Community code contains only two *references* proving the boundary:
  - `point_of_sale/static/src/app/services/pos_store.js:2051` — `if (isPrinted && !this.models["pos.prep.display"]?.length)` — i.e. core checks whether an (enterprise-loaded) `pos.prep.display` model is present to decide whether to force an order sync after printing.
  - `point_of_sale/models/pos_order.py:1545` — comment "This function is made to be overriden by pos_self_order_preparation_display" (a `_post_process` hook, enterprise).
- **The community mechanism for getting orders to the kitchen is therefore printer-only**: `pos.printer` records (IoT-box proxy or direct Epson ePOS) with per-printer `pos.category` routing, plus the client-side delta engine (`last_order_preparation_change` snapshot; NEW / CANCELLED / NOTE UPDATE tickets; course grouping; fire-course tickets; reprint) described in §3.3. There are **no kitchen order stages** in community (no bus-driven KDS, no per-line "todo/done" statuses); the only server-side "kitchen state" is the `last_order_preparation_change` JSON on `pos.order` and `restaurant.order.course.fired/fired_date`.
- Related community modules that exist and touch this area: `pos_self_order` (customer self-ordering, uses the same preparation-change snapshot via `pos.session._set_last_order_preparation_change`), `pos_restaurant_adyen` / `pos_restaurant_stripe` (tip adjustment on terminals), `pos_hr_restaurant`, `l10n_be_pos_restaurant`, `spreadsheet_dashboard_pos_restaurant`.

**Migration implication:** for feature parity with community you need printer routing + delta tickets; a graphical KDS with stages would be re-implementing enterprise functionality.

---

## 5. Frontend inventory (`static/src`) — components/screens added or patched

New screens (registered in `pos_pages` registry):
| Screen | Route | File |
|---|---|---|
| `FloorScreen` | `/pos/ui/<config>/floor` | `app/screens/floor_screen/floor_screen.{js,xml,scss}` |
| `SplitBillScreen` | `/pos/ui/<config>/splitting/{orderUuid}` | `app/screens/split_bill_screen/split_bill_screen.{js,xml}` + `xml/Screens/SplitBillScreen/SplitBillScreen.scss` |
| `TipScreen` | `/pos/ui/<config>/tipping/{orderUuid}` | `app/screens/tip_screen/tip_screen.{js,xml}` |

New components:
- `NumpadDropdown` (`app/components/numpad_dropdown/`) — floor-screen numpad to open a table by number / toggle table selector.
- `OrderCourse` (`app/components/order_course/`) — course header + its lines in the order display.
- `EditOrderNamePopup` (`app/components/popup/edit_order_name_popup/`) — rename floating order, with list of other floating orders to merge into.
- `TipReceipt` (`app/components/tip_receipt/`) — signature slip.
- `TipCell` (in `ticket_screen.js`) — inline tip editor in the ticket list.

New model classes (frontend ORM, `pos_available_models` registry): `RestaurantTable` (`app/models/restaurant_table.js` — link geometry `getX/getY/rootTable/children/setPositionAsIfLinked`, `getOrders/getOrder`), `RestaurantOrderCourse` (`app/models/restaurant_order_course.js`).

Patches (owl `patch`) on point_of_sale:
- `PosStore` (`app/services/pos_store.js`, ~1150 lines): everything in §2–3 — default page/idle redirect, direct-sale handling, guest count, courses (add/fire/transfer/clean), submit/reprint order, transfer/merge/unmerge orders, split continuation, floor scroll memory, category-count toasts, table lookup, sample-data restore, `getOrderData` (floor name + guest count on kitchen tickets).
- `PosOrder` (`app/models/pos_order.js`): customer_count default, isDirectSale/isFilledDirectSale, getName (T n & m), amountPerGuest, course accessors/selection/cleanup.
- `PosOrderline` (`app/models/pos_order_line.js`): note default/clone, `has-change` class, `canBeMergedWith` respects course, `isGlobalDiscountApplicable` hook.
- `PosConfig` (`app/models/pos_config.js`): `useProxy` with IoT devices, `isShareable ||= module_pos_restaurant`.
- `PosPayment` (`app/models/pos_payment.js`): `canBeAdjusted` default (non-cash, non-QR).
- `receiptLineGrouper` (`app/utils/order_change.js` patch): group receipt/kitchen lines by course.
- `DataServiceOptions` (`app/models/data_service_options.js`): registers `restaurant.order.course` as dynamic/cascade-delete/IndexedDB (`uuid` key) model.
- `DevicesSynchronisation` (`app/utils/devices_synchronisation.js`): dedupe concurrent orders per table.
- `OrderPaymentValidation` (`app/utils/order_payment_validation.js`): route to TipScreen when `set_tip_after_payment`; unlink child tables after validation.
- `PaymentInterface` (`app/utils/payment/payment.js`): `canBeAdjusted` / `sendPaymentAdjust` API.
- `Navbar` (`app/components/navbar/navbar.{js,xml}`): floor-plan/back-to-tables button, kanban toggle, tab visibility, order-name chip, bounce guard for filled direct sales.
- `ControlButtons` (`app/screens/product_screen/control_buttons/control_buttons.{js,xml}`): **Course**, **Bill**, **Guests**, **Split**, **Transfer / Merge**, **Transfer course**, **Edit Order Name** buttons (+ `SelectPartnerButton` re-registered).
- `ProductScreen` (`.../product_screen.{js,xml}`): Order/Reprint tracked actions, numpad "table" mode (jump-to-table by number), category-count chips, primary button logic.
- `ActionpadWidget` (`.../actionpad_widget.{js,xml,scss}`): Order button with per-category change badges, **Fire Course N** button, highlightPay logic.
- `OrderSummary` (`.../order_summary.{js,xml,scss}`): book/unbook table buttons, combo-course propagation on long-press, pending-order push on qty edits.
- `TicketScreen` (`app/screens/ticket_screen/ticket_screen.{js,xml}`): tip settling, TIPPING/OPEN states, table column/search, table-aware order opening, `TipCell`.
- `ReceiptScreen` / `FeedbackScreen` (`receipt_screen.js`, `feedback_screen.js`): "continue splitting" flow.
- `ReceiptHeader` (`app/screens/receipt_header_patch.js`) + `order_receipt.xml`: "Table N, Guests: C" header, **Pro forma receipt** banner, tip-suggestion footer.
- `PaymentScreen` templates (`app/screens/payment_screen/payment_screen.xml`): Close Tab / Keep Open buttons, amount-per-guest widget; `payment_screen_payment_lines.{js,xml}`: adjust-payment button.
- `OrderDisplay` (`app/components/order_display/order_display.{js,xml}`) + `order_tabs.xml` + `orderline.xml`: course grouping, unsent-change bubble on floating tabs, split-qty display.
- `PosRouter` (`app/services/pos_router_service.js`): empty patch placeholder.
- Kitchen ticket template extension: `store/order_change_receipt_template.xml` (guest count + floor name on `point_of_sale.OrderChangeReceipt`).
- Styles: `scss/restaurant.scss`, floor/actionpad/order-summary/split screen SCSS.

Tests (useful as behavior spec): tours `floor_screen_tour.js`, `pos_restaurant_tour.js`, `split_bill_screen_tour.js`, `tip_screen_tour.js`, `ticket_screen_tour.js`, `refund_tour.js`, `control_buttons_tour.js`, `devices_synchronization_tour.js`; unit tests for floor screen, split bill, tips, courses, tables; python `tests/test_pos_restaurant_flow.py`, `test_devices_synchronization.py`, `test_frontend.py`.

---

## Laravel + React parity checklist (condensed)

1. **DB**: `restaurant_floors`, `restaurant_tables` (self-FK `parent_id`), `restaurant_order_courses` (uuid, index, fired, fired_date, FK order); add `table_id`, `customer_count` to orders; `course_id` to order lines; config flags `iface_splitbill`, `iface_printbill`, `set_tip_after_payment`, `default_screen`, floor M2M; printers table with category M2M; predefined notes table; `last_order_preparation_change` JSON column on orders (+ serverDate metadata for conflict detection); `is_tipped`/`tip_amount` on orders.
2. **Floor designer**: CRUD floors/tables, drag/resize/snap, colors/shapes/seats/background image, duplicate floor/table, soft-delete with draft-order guards, table linking with order merge/unmerge.
3. **Kitchen**: category-routed printers, client-side diff → NEW/CANCELLED/NOTE-UPDATE tickets grouped by course, reprint, fire-course tickets, unsent-change badges, "send before pay" prompt, one-draft-order-per-table and multi-device conflict rules.
4. **Money flows**: pro-forma bill, split by line/qty with letter-suffixed orders + continue-splitting loop, transfer/merge orders, guest count everywhere, tip screen + after-payment terminal adjustment + bulk tip settling.
5. **KDS**: not in community — decide whether to rebuild (enterprise-only in Odoo).
