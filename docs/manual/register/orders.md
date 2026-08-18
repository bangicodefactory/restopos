---
title: Taking orders
audience: cashier
features:
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

## Two people opening the same table

If two waiters start an order for the same table at once, the till does not pick one and discard the
other. Both sets of items end up on **one bill** — the one that was opened first — and the second
device switches to it.

Nothing is lost and nothing is duplicated. The reconciliation is recorded like any other merge, so a
manager can see it happened and undo it if the two really were meant to be separate bills.

You will not usually notice this. It matters most on a busy pass, where the same table gets picked up
twice within a few seconds.
