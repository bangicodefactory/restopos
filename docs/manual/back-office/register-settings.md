---
title: Register settings
audience: manager
features:
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
