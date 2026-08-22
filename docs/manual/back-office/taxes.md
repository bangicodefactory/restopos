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

## Groups come first

A tax has to belong to a **group**, so a venue setting up from scratch makes the group first.

The group is the heading the tax totals under on the customer's receipt and on the session report.
Two taxes in one group print as one line — which is the point of them: an eco levy and a packaging
levy can both sit under *Levies* rather than cluttering every receipt with two rows nobody reads.

A group can print under a different name than it is filed under. Call it *Reduced rate — food* in the
list, where you need to find it, and give it the receipt label *VAT 6%*, which is what the customer
should see.

A group cannot be removed while it still holds taxes — move them first — and one that appears on a
closed session's report can never be removed at all. There is no *deactivate* for a group, so an
unwanted one is simply left empty.

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

Everything above can be changed after the fact — **between services**.

Changing a rate takes effect on the very next item rung up, immediately, with no need to restart a
till. Past sales are never rewritten: they keep the tax that applied when they were rung up.

**That is exactly why a tax cannot be re-rated while a table still has an open tab.** The starters
on that tab were priced at the old rate and are not recalculated; the mains would be priced at the
new one. The bill would carry one tax at two rates, add up correctly, and reconcile against neither
figure — with nothing on the receipt to show why. So while any open order carries the tax, the till
refuses to change:

- the rate, and whether it is a percentage or a fixed amount
- whether the price includes it
- either compounding switch, and the negative-factor switch
- the rounding, and the position in the evaluation order

Its **name**, its **receipt group** and whether it is **active** can still be changed at any time —
those change what is printed or offered, never what an already-rung line worked out.

Close or cash out the open tables and the change goes through.

## Remove a tax

Several things can stop you, and the till says which:

- **An open tab still carries it.** Close or cancel those first — this is the one you can act on
  straight away, and it is checked before the rest.

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
