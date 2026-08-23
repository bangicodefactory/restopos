---
title: Products
audience: manager
features:
  - BOF-081
  - BOF-082
  - BOF-083
  - BOF-094
---

# Products

The menu. Everything a till can sell is a product here.

## Add a product

**Products → Add**, with a name and a price. Everything else is on the product's own page once it
exists, so adding the dish you started serving this morning takes two fields.

A new product is created in your venue's default unit — "each" — and can be sold straight away.

## What each setting does

Most of the editor is self-explanatory. Four settings are not, and they change how the register
behaves rather than how the product looks:

- **Sold by weight.** The till reads the quantity from the scale instead of counting units. Turn it
  on for anything priced per kilo and the cashier stops typing quantities.
- **Track stock** / **allow negative stock.** Whether the count moves when the item sells, and
  whether it may go below zero. A kitchen that runs out mid-service usually wants negative stock
  allowed; a shop counting bottles usually does not.
- **Unit of measure.** What the price is *per*. Changing it does not convert existing prices.
- **Product type.** Consumable, service, or a combo. A combo is built from other products on its own
  page.

The three description fields are for three different readers:

- **Sales description** — the cashier, on the till.
- **Public description** — the guest, on the online menu.
- **Internal note** — staff only, printed nowhere.

**There is no image upload yet.** The field is absent rather than greyed out, because a locked
control suggests a permission you might be granted and this is a feature that does not exist.

## Taking a dish off the menu

**86 it from the product list** — one tap on the row, no need to open the product. "86" is kitchen
shorthand for "we are out", it happens mid-service at speed, and the guest-facing menu drops the
dish immediately without anybody reloading anything.

Putting it back is the same tap.

## Changing availability during service

**While a session is open, whether a product is available on the tills cannot be changed**, and it
cannot be archived. Renaming and re-pricing are fine.

The reason is that each till holds its own copy of the menu, taken when the session opened. Pull a
product mid-service and it is still on the screen in front of the cashier, still addable — and the
order that includes it then names something the back office says is gone.

Taking a dish off the **guest-facing** menu is not blocked, which is why 86-ing works during service
and archiving does not.

## Archive a product

**Archive**, never delete. The product disappears from every till and picker; every past sale, report
and export stays exactly as it was.

That is not a limitation to work around — a sale that cannot say what was sold is worse than a menu
with an old dish on it. Its variants are archived with it, so nothing is left sellable behind a
product that is gone.

## Who can change this

Products are register configuration and need the same permission as the rest of the setup — worth
noting, because until recently any signed-in account could reprice the catalogue every till sells
from.
