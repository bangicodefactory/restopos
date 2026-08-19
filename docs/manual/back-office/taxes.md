---
title: Taxes
audience: manager
features:
  - BOF-091
---

# Taxes

A tax sits on every line of every sale, on a document with legal weight. Getting one wrong is not
visible on the receipt — the total simply comes out different — so this is the page to change
carefully and check afterwards.

## Add a tax

**Taxes → Add**. Beyond a name and a rate, four settings decide what the tax actually does:

- **Kind** — a **percentage** of the line, or a **fixed amount** per unit. An eco levy of 20c a
  bottle is fixed; VAT is a percentage.
- **Group** — the heading it totals under on a receipt and on the reports. Two taxes in one group
  print as one line.
- **Subtracts rather than adds** — for a withholding-style line that comes off the total.
- **Rounding** — where the fractions of a penny land. Leave it on *inherit* unless you have been told
  otherwise; it changes the total by a penny at a time and those pennies are what a tax return is
  reconciled against.

Two more switches control compounding, and they are independent:

- **Included in the price** — the shelf price already contains the tax.
- **Affects the base of later taxes** / **is affected by earlier ones** — one compounds forward, the
  other backward. A tax can do either, both or neither.

## Change a tax

Everything above can be changed after the fact. Changing a rate affects sales from that moment on;
it does not rewrite what has already been sold — past orders keep the tax that applied when they
were rung up.

## Remove a tax

Three things can stop you, and the till says which:

- **It is still applied to products.** Take it off them first. Otherwise those products would quietly
  become untaxed, which nobody would notice until a return was filed.
- **A fiscal position maps to or from it.** Removing it would leave that position silently no longer
  remapping — a customer entitled to an exemption would be charged the full rate on a sale that looks
  perfectly correct. Take it out of the position first.
- **It is part of a compound tax.** The parent would carry on computing, quietly short by whatever
  the removed part contributed.
- **It is on a closed session's report.** Then it can never be removed, by anyone. The report's tax
  figures are frozen at close, and deleting the tax would leave a report that cannot explain its own
  total.
- **Nothing points at it.** Then it goes.

**In almost every case, deactivate rather than delete.** A deactivated tax disappears from the tills
and from every picker, and every report that mentions it stays intact. "Remove this tax" nearly
always means "stop using it".

## Who can change this

Taxes are register configuration and need the same permission as the rest of the setup.
