---
title: Products
audience: manager
features:
  - BOF-081
  - BOF-082
  - BOF-083
  - BOF-085
  - BOF-087
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

## Options

Options are the choices offered on a dish: *Size — small, medium, large*. *Cooking — rare, medium,
well done.* *Extras — bacon, avocado.*

They are defined once for the venue, on **Product options**, and then offered on the products that
have them. "Size" means the same thing on every dish, and a per-product copy becomes three spellings
of "Large" by the second month.

### Defining an option

Beyond a name, two settings decide how it behaves:

- **Display** — what the till shows: radio buttons, pills, a dropdown, colour swatches, or multiple
  choice. **Multiple choice is the only one that lets a guest pick more than one**, so it is what
  extras want and what sizes do not.
- **Variants** — whether choosing produces a distinct sellable item. *One variant per combination*
  suits a size that has its own barcode and its own stock. *No variant* keeps one item and records
  the choice on the order line, which is what "no onions" wants: nobody stocks an onion-less burger.

A value can be marked **free text** instead of a choice — "name on the cake". The guest types rather
than picks.

### Offering an option on a product

On the product's **Options** tab, add the option and tick the values this dish offers. Each ticked
value gets a **supplement**: what it adds to *this* product's price.

The supplement lives here rather than on the value itself because "large" is +2.00 on a coffee and
+6.00 on a pizza. A venue forced to choose one number for both would stop using the feature.

**Mark the choice required** to stop "one coffee" reaching the kitchen without a size.

A ticked list with nothing in it renders an empty picker on the till, so the page says so before you
save.

### Removing options

Past orders record what was chosen, so:

- An option **a product offers** cannot be deleted — take it off the products first.
- A value **an order has chosen** cannot be removed from a product, and neither can the whole option
  line. That includes free-text values somebody typed.

**Deactivate instead** in every one of those cases. The option disappears from the till and every
past order keeps saying what it was sold with.

## Variants

A variant is a size, a flavour, a version — and it is what a sale actually records. A product on its
own is not sellable; the till adds a *variant* of it. Every product has at least one, even when
there is nothing to choose between.

The **Variants** tab on a product is where they live.

- **Suffix** — what tells this one apart. "Large", "Gluten free". The till button reads the product
  name plus the suffix, so leave it blank only for a product with a single variant.
- **Supplement** — what this variant costs *on top of* the product price. Set the large at +2.00 and
  a later price change to the product carries through to every size automatically. That is the whole
  reason it is a supplement rather than its own price.
- **Barcode** — its own, scannable at the till. It has to be free: a barcode already used by another
  variant *or by a product* is refused, because the same code scanning two different things means the
  till rings up whichever it happened to index first, and nothing anywhere reports the conflict.
- **On hand** — see below.

### Stock is recorded but nothing moves it yet

You can type an on-hand count and it will be saved. **No sale decrements it.** The stock ledger is
not built, so the number stays exactly as you left it until somebody edits it again.

It is worth knowing before you rely on it for anything.

### Archiving a variant

Archive, never delete: every past sale points at a variant, and a history that cannot say *which*
size was sold is worse than a menu carrying a discontinued one.

**The last variant cannot be archived.** A product with none cannot be added to an order at all — it
appears on the menu and simply refuses to be tapped. Archive the product instead.

As with products, this is refused while a session is open. Prices and names can still be changed
mid-service; a sold line records what it charged.

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
