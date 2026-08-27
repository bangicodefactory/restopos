---
title: Register settings
audience: manager
features:
  - BOF-006
  - BOF-040
  - BOF-031
  - BOF-032
  - BOF-033
  - BOF-034
  - BOF-035
  - BOF-036
  - BOF-037
  - BOF-038
  - BOF-041
  - BOF-044
---

# Register settings

Every till is configured on its own page: **Registers → open a register**. The settings are grouped
into tabs that match how you actually work — what the register looks like, how it takes payment,
what it prints, what it sends to the kitchen.

Saving any of these tells every till attached to this register to refresh. A till that is mid-sale
finishes that sale first, so you can save during service.

Only an owner can change these. A manager can look at the page but not save it — the Save button
stays greyed out with the reason.

## Open a register

**Back office → Registers → Open a register.** A name, a currency, and whether it is a restaurant.
Everything else has a sensible default and is set afterwards on the settings screen, which is what
the rest of this page is about.

**The currency is the one field you cannot change later.** Once a register has taken a payment, every
sale and every till count it recorded carries amounts with no currency of their own — they read as
whatever the register says. Changing it afterwards would silently restate all of them. Pick it now.

## Copy a register

A second till in the same venue usually differs from the first in its name and almost nothing else,
and this settings screen has eleven tabs. **Duplicate** copies all of it — the settings, the payment
methods, the price lists, the floors, the staff, the kitchen screens — and gives the copy its own
name, which you can change straight away.

**Cash payment methods are not copied**, and the confirmation says so. A cash method belongs to
exactly one register: two tills sharing one means two sessions counting the same drawer, so a float
added on one register is expected in the other's count. Nobody notices until a drawer comes up short
and the report blames a cashier. Add a separate cash method for the new till.

## Archive a register

**Archive** takes a register out of service. It stops appearing on any till and stops being offered
for pairing.

It is archived, never deleted. Every session, order and payment it took names it, and those records
have to keep meaning something — a sales report from last year cannot point at a register that no
longer exists.

**A register with a session open cannot be archived.** Close the session first, or the drawer count
in progress is stranded with nowhere to go.

## Choose the prices a register quotes

The two most important settings on the page are on the **Pricing** tab.

**Default price list.** Leave it empty and the till charges each product's own sale price. Choose
one — "Happy hour", "Terrace", "Staff" — and the till charges that list's prices instead, for every
sale on this register, until you change it back.

A price list has its own currency. If you pick one that prices in a different currency from the
register, the save is refused: the till has no way to convert, so it would show that list's numbers
under this register's currency symbol and charge them as-is.

**Default tax position.** A tax position rewrites which taxes apply — takeaway at a lower rate,
export with none. Set one here and every sale on this register starts with it applied. Leave it
empty and each product's own taxes are used.

Both take effect on the next sale, not retroactively.

## Set up how the register takes money

On the **Payments** tab:

- **Cash control** asks the cashier to count the drawer at the start and end of every shift. Turn on
  **maximum difference** underneath and set an amount to decide how far off a count may be before a
  manager has to approve the close.
- **Cash rounding** snaps cash totals to a step — 0.05 where the one- and two-cent coins are gone.
  Switch it on and then choose the rounding rule; the rule list stays greyed out until you do.
  **Round cash only** leaves card payments to the cent and rounds nothing but cash.
- **Fast payment** puts the most-used payment methods as one-tap buttons on the payment screen.
- **Validate terminal payments automatically** closes the sale as soon as the card terminal says
  approved, instead of waiting for the cashier to confirm.

## Choose the service modes a register offers

On the **Assignments** tab, switch on **Service modes** and tick the ones this register takes —
eat-in, takeaway, delivery. Then pick the **default**, which is the one a new order starts on.

Choosing a default adds it to the list of offered modes if it was not already there. A default the
register does not offer would open every order on a mode it then refuses.

Leave service modes off and every order is a plain sale, which is what a counter without table
service usually wants.

## Change what the till looks like

On the **Interface** tab:

- **Product images** and **Category images** — turn both off for a text-only grid, which fits far
  more products on screen and is what a busy bar usually prefers.
- **Group by category** puts headings between the product groups instead of one flat grid.
- **Large scrollbars** widens the scrollbars for a touchscreen used with gloves.
- **Employee login** asks each cashier to identify themselves by PIN or badge, so every sale is
  attributed to a person. Turn this on before you rely on per-cashier reports.

**Automatic return** is how many seconds the till waits after a sale before going back to the
default screen — the floor plan in a restaurant, the register in a shop.

## Choose what the receipt does

On the **Receipts** tab:

- **Print automatically** prints as soon as a sale is settled, without asking.
- **Skip the receipt screen** goes straight back to a new sale — pair it with automatic printing, or
  the guest gets nothing.
- **Simplified receipt** prints a shorter slip without the tax breakdown.
- **Header and footer** put your own lines at the top and bottom. Switch **show header and footer**
  on for them to appear.

## Restaurant and kitchen

On the **Restaurant** tab, **print the bill early** lets a waiter print the addition before payment.
On the **Preparation** tab, **fire the first course automatically** sends the first course to the
kitchen as soon as the order is sent, rather than waiting for the waiter to release it.

## Connect the hardware

**Register settings → Connected devices.** This is where a till learns about the equipment sitting
next to it.

**IoT box.** The box that connects a scanner, a scale, a receipt printer and a cash drawer to the
till. Switch it on, put in its address, then tick what is actually plugged into it. The four ticks
stay greyed out until the box is on, because a scanner ticked with no box behind it is a setting
that reads as configured and does nothing.

**ePOS printer.** A network printer the till talks to directly, without a box in between. Same
shape: switch it on, then give its address.

**Addresses are addresses, not web links.** Type `192.168.1.50`, or `192.168.1.50:9100` if it uses a
particular port, or a name like `printer.local` if your network has its own. A full web address —
anything with `http://` in front of it, or a slash, or a question mark — is refused.

That refusal is worth understanding rather than working around. The till fetches from whatever is in
this box, on your own network, with nothing checking that the thing answering is the printer you
meant. If a web address could go here, one typed by mistake — or by someone who should not have been
in this screen — would quietly point every till on this register somewhere else, and printing would
appear to work.

**Customer display background.** The picture shown between sales on the screen facing the customer.

## Track who changes an order

On the **Accounting** tab, **track order edits** records each change to an order that has already
been sent — what changed, who changed it, when. Turn this on if you ever need to answer "who took
that item off the bill".

## What you cannot change here

**The currency** is fixed once the register has taken its first payment. Every sale and every till
count already recorded carries amounts with no currency of their own — they read as whatever the
register says. Changing it afterwards would silently restate yesterday's takings in the new
currency. If you need a register in another currency, create a new one.

**The company** a register belongs to is never editable. Its sales, sessions and payments belong to
that company, and moving the register would leave them behind.

Some tabs — self-service ordering, connected hardware, loyalty — still show their switches greyed
out with a note. Those are not settings that quietly do nothing; they are surfaces still being
built, and the note says so rather than letting you flip a switch that saves into nothing.
