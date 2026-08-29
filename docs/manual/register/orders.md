---
title: Taking orders
audience: cashier
features:
  - REG-373
  - REG-374
  - XCT-014
  - REG-071
  - REG-081
  - XCT-059
  - REG-100
  - REG-101
  - REG-103
  - REG-104
  - REG-105
  - REG-107
  - REG-109
  - REG-110
  - REG-111
  - REG-112
  - REG-113
  - REG-119
  - REG-120
  - REG-123
  - REG-125
  - REG-290
  - REG-292
  - REG-293
  - REG-295
  - REG-300
  - REG-301
  - RST-072
  - REG-175
  - RST-144
  - RST-058
  - REG-372
  - RST-057
  - RST-140
  - RST-141
  - RST-050
---

# Taking orders

## Add items

Tap a product to add it. Tapping the same product again **adds to the existing line** rather than
creating a second one — so two coffees show as one line of 2, and the kitchen gets one ticket
saying two.

Lines only merge when they are genuinely the same thing: same product, same price, same discount,
same note, and in a restaurant the same course. Change any of those and you get a separate line,
which is what you want.

Items with options show their full name including the choices made, so *Pizza (large, extra
cheese)* reads correctly on the receipt and in the kitchen.

## Scanning

A barcode scanner plugged into the till works everywhere on this screen — you do not have to tap
into the search box first. Scan, and the item is added.

### Scanning with the tablet camera

On a tablet with no scanner attached, tap **Scan with the camera** next to the search box. A small
preview appears above the product grid; hold the barcode in front of it and the item is added
exactly as a hardware scan would add it — including labels that carry a weight or a price.

The button only appears on devices that can do it, and the camera is switched off the moment you
leave this screen. If the camera cannot be opened — permission refused, or an older tablet — the
till keeps working with the hardware scanner.

### When a barcode is not recognised

The till keeps only part of the menu on the device, so a barcode it does not know is not
necessarily a barcode that does not exist. It asks the server, and if the product is there it is
added to the order and kept on the device for next time.

If it still cannot be found you get **Unknown barcode**, with the digits, and the code is dropped
into the search box so you can look for the item by name or have it created.

If you are **offline** the till says so — *Unknown product, connect to look it up* — rather than
telling you the product does not exist. Those are different problems: the second one is worth
walking to the stockroom about, the first one only means the wifi is down.

## Change a line

Select the line, then use the keypad:

- **Quantity** — how many
- **Price** — the unit price, if you are allowed to set it
- **Discount** — a percentage from 0 to 100

Changing the price or applying a large discount may need [a manager](approvals.md).

### Reducing something the kitchen already has

If you reduce a quantity **below what has already been sent to the kitchen**, the till does not
quietly rewrite history. It adds a compensating negative line instead, so the kitchen sees that two
were ordered and one was taken off. The record matches what actually happened in the pass.

## Notes

- **Customer note on a line** — prints on the customer's receipt.
- **Kitchen note on a line** — goes to the kitchen, not the customer. Common ones are available as
  chips so you do not have to type "no onions" fifty times a night.
- **Order-level notes** — one for the customer, one internal.

## Run several orders at once

Orders appear as tabs across the top. Start a new one without losing the current one, and switch
freely — each tab keeps its own screen state, so you come back to where you were.

Give a tab a name (*"table 4"*, *"the man in the hat"*) so you can tell them apart at a glance.

## Find an earlier order

The ticket screen has the list on one side and the detail on the other.

Search by receipt number, reference, invoice number, date, customer, table, or the cardholder name
on the payment. Paid orders are fetched from the server as you page through, so you are not limited
to what this device happens to remember.

From the detail pane you can view an order read-only, start a [refund](refunds.md), or produce an
invoice.

### Deleting an order

Deleting is guarded, and if the kitchen has already been told about the order, the cancellation is
sent through to them too — a deleted ticket that leaves food cooking is worse than no delete at
all.

## Orders that have been paid

Once an order is settled, it is closed to editing. Attempts to change lines, payments or courses on
a paid order are refused, and the attempt is recorded. Edits made before payment are flagged on the
order, so a manager reading the shift afterwards can see which tickets were altered and which lines
were removed.

## Guests

Some service modes need to know how many people are eating before the order goes to the kitchen —
a dine-in table does, a takeaway does not.

On those, the till asks for the number the first time you send. Until you give it, the order does not
go through: a kitchen cannot plate a table it cannot count. Enter it once and you will not be asked
again, even when you add to the order later.

You can set or change it at any time from the guests button on the order.

## Tax mapping (fiscal position)

Most venues never touch this. Where a sale is taxed differently — takeaway at a lower rate, an
exempt customer, an export — the mapping decides which rates apply.

Four things can set it, and the strongest wins rather than the most recent:

| Set by | Beats |
| --- | --- |
| You, by hand | everything |
| The service mode (preset) | the customer's mapping, the register default |
| The customer's own mapping | the register default |
| The register default | — |

So choosing **Takeaway** and *then* attaching a regular customer keeps the takeaway rate: the sale is
still takeaway. If that customer genuinely needs their own mapping on this sale, set it by hand and
nothing will override it.

## Orders you cannot cancel

An order placed for a **later time slot** cannot be cancelled from the till. It is a booking the
kitchen has not started, and cancelling it mid-service is nearly always a mistap on an order you did
not mean to be looking at. Once the slot has passed it cancels like any other order.

## When the server disagrees with your till

Two tills can drift — one takes an order while the other is offline, or the same table gets picked up
twice. When the server refuses or replaces something your till sent, the till now **fetches the
server's version and shows you that**, rather than leaving you looking at a bill that has already
been overruled.

You may see the order change under you. That is the point: the version on screen is the one the
kitchen and the other tills are working from.

If an order was merged into another table's bill, the till switches you to the surviving bill so you
are not editing something that no longer exists.

A sale the server genuinely refuses is different — it stays flagged for a manager rather than being
quietly replaced.

## Two people opening the same table

If two waiters start an order for the same table at once, the till does not pick one and discard the
other. Both sets of items end up on **one bill** — the one that was opened first — and the second
device switches to it.

Nothing is lost and nothing is duplicated. The reconciliation is recorded like any other merge, so a
manager can see it happened and undo it if the two really were meant to be separate bills.

You will not usually notice this. It matters most on a busy pass, where the same table gets picked up
twice within a few seconds.

## What an order is called

Every order carries a name, and it is the same name everywhere — the order list, the receipt, the
kitchen ticket and any other till.

| The order is | Called |
| --- | --- |
| on table 5 | **T 5** |
| on two tables pushed together | **T 3 & 4** |
| a counter sale | **Direct Sale** |

Type your own name at any point — a customer's name, "birthday party" — and it sticks. Moving the
order between tables will not overwrite it. Clear it and the automatic name comes back.

**Collection and takeaway orders must be named.** They have no table number to be called by, so the
till asks before the order goes to the kitchen — while the customer is still in front of you.

## Moving an order to a table

From the order list, pick **Move to…** on an open order and choose a table.

- Choosing a **free** table moves the order there.
- Choosing a table that already has a bill **merges** the two.

You do not have to decide which of those you are doing: it follows from the table you pick. This is
the way to seat an order that is not on a table yet — a counter sale the customer decides to eat in —
which the floor plan cannot help with, because there is nothing there to drag.

## Pushing two tables together

A party of eight arrives and you seat them at two tables of four. On the floor plan, **hold one
table for a moment until it lifts, then drag it onto the other and let go.**

- The two tables become one, shown as a single tile — `3 & 4`, with the covers of both.
- If the table you dragged already had a bill, it moves onto the other one. If both had bills, they
  are merged into one.
- Tapping either table now opens the same bill.

Only tables in the same room can be pushed together, and only onto a table that is not already part
of a group. Tables that cannot take the drop simply do not light up while you are dragging.

**Changed your mind?** Let go anywhere that is not a table, or press Escape. Nothing happens until
you drop onto a table.

A short tap still opens the table as usual, and sliding your finger to scroll the room does not pick
a table up — the hold is what tells the two apart.

### Separating them again

Press **Unlink** on the table that was pushed over.

The bill stays where it is. Unlinking separates the furniture; it does not split the money. To give
one group its own bill again, use the payment screen's split, or undo the merge from the order list.

## Bills from another till

Where two registers are set up to share, each one lists the other's open bills so a table started on
the terrace can be finished at the bar. Those rows are marked with the till they came from, so you
know whose sale you are editing.

If the other till uses a **different currency**, its bills are listed but cannot be opened here, and
the till says which register to use instead. The amounts on such a bill are in another unit, and this
register would offer its own payment methods against them — the sale would balance to a number that
was never the price, and nothing afterwards would look wrong.

## The register is open in another tab

Only one browser tab can take sales at a time. If you open the register a second time on the same
computer, that tab says so and does not sell.

This is not a limit for its own sake. Both tabs would share the same local database and the same
queue of sales waiting to reach the server, and both would try to send them — so an order could go
up twice and appear on the report twice.

Close the other tab and this one takes over on its own. You do not need to reload it, and you do not
lose anything you had on screen.

If the other tab is gone but this one still says it is blocked — a browser crash, say — wait a few
seconds. When a tab stops responding the register notices and hands over by itself.

## Repair local data

In the sync panel, under **Repair local data**. Use it when the till works but shows something that
is plainly out of date — a product missing that the office added this morning, a price that will not
change no matter how often you sync.

It re-downloads the catalogue and rebuilds what is stored on this device. The register stays paired,
your open orders stay where they are, and nobody has to enter a manager code.

**It refuses while sales have not reached the server yet**, and tells you how many. Repair is the
button you reach for when something already looks wrong, and that is exactly the moment when
rebuilding from a server that has never seen those sales would quietly lose them. Sync first — use
**Sync now** in the same panel — and then repair.

If it is still wrong after a repair, the last resort is **Reset this device** on the start-up screen.
That one does clear the pairing, and a manager has to pair the till again.
