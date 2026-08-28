---
title: Service modes
audience: manager
features:
  - BOF-113
---

# Service modes

A service mode is how a venue tells one kind of sale from another: eating in, taking away, delivery,
a members' counter. Staff pick one at the register when they start an order, and the mode decides
three things by itself — what the customer pays, what tax is charged, and what the customer has to
give you before you can take the order.

The modes the product ships with are marked **Built in**. Rename them, re-price them, switch them
off — but they cannot be deleted, because every register falls back to one.

## Adding a mode

**New service mode** asks four things.

**Name** is what the staff see on the register, so name it the way they would say it: *À emporter*,
*Livraison*, *Terrasse*.

**Served** — at the counter, at the table, or by delivery. This is what the mode *is*, and the
kitchen ticket says it.

**Price list** is what the mode charges. Leave it empty and the register's own prices apply. A
delivery tariff that covers the courier is a price list attached here.

**Fiscal position** is what the mode taxes at. This is the one that matters most: in most countries
the same dish carries one VAT rate eaten in and another taken away, and that difference is the tax
authority's money either way. A takeaway mode with no fiscal position charges eat-in VAT on every
takeaway sale.

Whatever you set here beats the register's own settings, which is the whole point — a register
serves both, and the mode is what tells them apart.

## Asking the customer for something

**Customer identification** decides what has to be filled in before the order can be taken:

- **Nothing** — the counter case
- **Their name** — a collection order that has to be called out
- **Their address** — delivery, where an order with no address cannot be fulfilled at all

Set this to match reality. It is a hard stop at the register, so asking for an address on a counter
mode will slow every sale.

## Bookings and opening hours

Switch **Take bookings** on and the mode stops taking orders as they come and starts taking them for
a time. Two numbers describe the capacity:

- **Orders per slot** — how many the kitchen can handle at once
- **Slot length** — how long each slot lasts, in minutes

Five per twenty minutes means the eleventh order for the same twenty minutes is refused, and the
customer is asked to pick another time. That refusal is the feature: without it the kitchen finds
out when the tickets arrive together.

**Opening hours** are set per day, one window per row. Outside them the mode takes no bookings at
all.

Two things worth knowing:

- A mode with **no hours at all** takes bookings at any time. That is deliberate — a mode you have
  just switched booking on for should not silently refuse everything.
- Once **any** day has hours, a day with none is a day you are closed. A Monday-only delivery service
  refuses Tuesday, which is what you want and is worth checking after you add the first row.

Windows on the same day cannot overlap. Lunch 11:00–14:00 plus a second row 13:00–15:00 looks like an
extension and is a double booking — widen the first row instead.

## Removing a mode

A mode can only be removed while nothing points at it. It is refused if:

- it is **built in**
- **orders were taken under it** — that is how you answer "how much of last month was delivery", and
  removing the mode erases the answer rather than the row
- **a register opens on it** — point that register at another default first

Switching a mode off is nearly always what you want instead. It stops being offered on every
register, and every past order keeps saying how it was taken.

The same guard applies to switching off: a mode a register opens on cannot be deactivated either,
because that register would open with no service mode and every order would arrive without one.
