---
title: Price lists
audience: manager
features:
  - BOF-090
---

# Price lists

A price list is a set of rules that change what a product costs without touching the product. Happy
hour, a members' rate, a takeaway tariff, twenty per cent off desserts for a week — all of them are
the same thing: a list, and rules inside it.

The product keeps its own price throughout. Nothing here edits the catalogue, so turning a price
list off returns every price to normal in one step.

## Making a list

**New price list** asks for two things: a name and the currency it prices in.

Pick the name your staff would recognise on a register — *Happy hour*, *Terrasse*, *Membre* — because
it is the name that appears when someone switches price list mid-service.

The currency is the one the amounts inside the list are written in. **Nothing converts.** A list
priced in dollars, attached to a register that quotes in euros, would put dollar amounts on a euro
receipt, so a register refuses a price list whose currency is not its own. If you need the same
tariff in two currencies, that is two lists.

You can change a list's currency later only while no register is using it. Once a register quotes
from it, that change is refused — detach it from the register first.

## Adding a rule

Open a list and choose **Add a rule**. There are two questions and they are independent of each
other.

**What the rule covers.** Every product, one category, or one product. A rule that covers a category
covers everything in it, including anything you add to that category later.

**How the price is worked out.** Either a percentage off the normal price, or a flat price that
replaces it.

A rule saying it applies to a product with no product chosen would match nothing and change no price,
so that is refused rather than saved. The same goes for a discount of zero per cent, and for a fixed
price of zero — which would sell the item for nothing.

## Which rule wins

Several rules can apply to one product at once, and only one of them decides the price. The most
specific wins:

1. a rule for a particular variant
2. a rule for a product
3. a rule for a category
4. a rule covering everything

So a list can hold *"−10 % on everything"* and *"desserts €5"* at the same time: a dessert costs €5,
and everything else is ten per cent off. When two rules are equally specific, the one with the lower
sequence number wins.

The **Precedence** column on the list shows exactly this ordering, which is the fastest answer to
"why is this price not applying". A rule outside its date window, or switched off, is greyed out —
usually that is the answer.

## Removing things

A rule can be removed at any time; prices go back to what they were on the next order.

A whole list can only be removed while nothing points at it. It is refused if:

- **an order was priced with it** — a past order says what it was priced against so the amount can be
  explained later, and removing the list would erase that. Switch the list off instead: it stops being
  offered and every past order keeps its record.
- **a register uses it** as its default — point that register elsewhere first.
- **another list computes from it** — those prices would quietly fall back to the normal product
  price.

Switching a list off is almost always the right move. It disappears from the registers immediately
and nothing is lost.
