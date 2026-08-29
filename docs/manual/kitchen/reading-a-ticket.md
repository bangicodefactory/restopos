---
title: Reading a kitchen ticket
audience: kitchen
features:
  - KDS-005
  - KDS-006
  - KDS-055
  - KDS-012
  - KDS-059
  - KDS-061
  - REG-297
  - RST-073
---

# Reading a kitchen ticket

A ticket tells you three things: **where the food is going**, **what to make**, and **anything
unusual about it**. They appear in that order, on the screen and on paper.

## Where the food is going

The top of the card answers this before anything else, because it changes what you do with the plate
when it is finished.

| You see | It means |
| --- | --- |
| **Service: DINE IN** with a table | Run it to that table |
| **Service: TAKEAWAY** | Bag it for the counter |
| **Service: DELIVERY** | Bag it for the driver |
| A customer name | Who to call when it is up |

If a service line is missing, the order was taken without one — treat a ticket with a table as
dine-in and one without as counter collection, and ask if it matters.

**Guests** is how many people are eating, not how many dishes to make. Quantities are always on the
items themselves. It is absent on a takeaway, and on any order taken without a cover count.

## What to make

Each line is a quantity and an item. Where the item was ordered with options, they follow it in
brackets:

```
1 x Cake (Chocolate, Happy Birthday)
2 x Burger (Rare, No pickles)
```

Everything in brackets was chosen by the customer at the till. "Happy Birthday" is text somebody
typed rather than an option picked from a list — it is written out exactly as it was entered, so
read it as an instruction, not a label.

### Set menus

When a set menu is ordered, its parts are listed **underneath it and indented**, with a line down
the left:

```
1 x Menu du jour
  │ 1 x Soupe du jour
  │ 1 x Steak frites
  │ 1 x Café
```

The indented items belong to the menu above them. That matters when two menus are on one ticket:
without the grouping you would see six unrelated items and no way to tell whose coffee is whose.

Very occasionally a part appears on its own, not indented under anything. That happens when its menu
went to a different station, or the order was moved between tables. Make it — it was ordered.

## Anything unusual

Two marks appear under a line:

- `!` is a note **for the customer's sake** — an allergy, a preference, a change to the dish.
- `*` is a note **for the kitchen's sake** — an internal instruction.

Treat a `!` as binding. It is the line that stops food going out wrong.

Notes attached to the whole order, rather than to one dish, sit at the top of the card. See
[Notes on the kitchen screen](notes.md), including what happens when one arrives after you have
already started cooking.

## Courses

When an order is split into courses, the ticket groups the items under `- Course 1 -`,
`- Course 2 -` and so on. A course only reaches you when the front of house fires it, so a ticket
showing one course is not an incomplete order — it is the part you are meant to be cooking now.

## Showing only some of the board

The row of buttons above the tickets narrows what you see. **All** clears everything back.

- **A category** — only your station's items. Useful on a display shared by the grill and the fryer.
- **A course** — starters, then mains, when the room is running by course.
- **A service mode** — *Takeaway*, *Delivery*, and so on. A driver is waiting and you want only the
  bags; a takeaway that sits under a dine-in ticket is a takeaway that goes cold.
- **Late** — only the tickets at or past the late threshold.

You can combine them, and you can pick more than one category or service mode at once. Only the
modes actually on the board right now get a button, so a *Delivery* button never appears on an
evening with no deliveries.

A ticket hidden by a filter is hidden, not gone. **It is still ordered and still has to be made** —
clear the filter before the end of service so nothing is left sitting.

## Putting a ticket on paper again

If a printer jammed, ran out of paper, or somebody binned the ticket, the cashier can reprint it
from the order — **Reprint** on the order panel. It puts the last ticket out again exactly as it was.

Two things about a reprint worth knowing:

- **It does not re-send anything.** Nothing new is fired, nothing is cooked twice, and the board does
  not change. It is a second copy of a ticket that already went out.
- **The copy is marked.** A reprinted ticket carries a DUPLICATA banner across the top, so nobody at
  the pass mistakes it for a fresh order.

Reprint is per till and per shift: it replays what *this* register last printed. A ticket sent from
another till, or before this one was reloaded, is not there to replay.

## What the cashier sees when a ticket is sent

The till confirms a send by naming what went where — "3 × Plats, 2 × Boissons" — rather than a bare
"sent". A cook missing a course usually notices as an argument at the pass; the count on the cashier's
screen is what makes it an argument about a number instead.
