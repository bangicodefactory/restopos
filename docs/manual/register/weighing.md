---
title: Weighing a product
audience: cashier
features:
  - REG-077
  - XCT-058
---

# Weighing a product

Some products are sold by the kilo rather than by the item — cheese, olives, charcuterie. Tapping
one of those on the product grid does not add a line straight away. It opens the weighing dialog,
and the line is added once there is a weight to put on it.

## With a scale connected

The dialog shows the live weight and updates several times a second. You do not type anything.

1. **Empty the scale.** The dialog will not let you confirm until it has seen the pan empty. That is
   deliberate: it is how the till knows the last item actually came off before the next one goes on.
2. **Place the item.** The weight climbs and then settles.
3. **Confirm** once the reading is steady. The line is added at that weight.

The line under the weight tells you what is stopping you at any moment:

| What it says | What to do |
|---|---|
| *Empty the scale, then place the item on it.* | Take everything off the pan. |
| *Waiting for the weight to settle…* | Wait a second. Something is still moving. |
| *Weight is stable — confirm to add it.* | Confirm. |
| *No scale on this till — enter the weight by hand.* | See the next section. |

**Tare** subtracts a container. Put the empty tub on the scale, tap **Tare**, then fill it: the
weight shown is the contents alone. Tare it again, or empty the scale, to start over.

## Without a scale

If this till has no scale — or the scale is switched off in the back office, or your browser cannot
talk to it — the dialog shows a numpad instead and you type the weight in kilograms. Three decimal
places: `0.250` is 250 grams.

This is a normal, supported way to work. The till records that the weight was entered by hand rather
than measured, which is a distinction a trading-standards inspector is entitled to ask about, so it
is worth using the scale when there is one.

On a till that has a scale, **Enter by hand** switches this one weighing over to the numpad — for
when the scale has stopped answering mid-service.

## The two rules that will stop you

Both exist because weighing is regulated in France and Belgium, not because the till is being
awkward.

**You cannot ring the same weight twice for the same product on the same bill.** If you weigh 200 g
of gruyère and then confirm 200 g of gruyère again on the same order, the second is refused with
*The weight has not changed — weigh again.* Re-weigh the item; the number will differ, because no
two handfuls weigh exactly the same.

This is scoped to one product on one bill. 200 g of gruyère followed by 200 g of olives is fine.
So is the next customer buying the same 200 g of gruyère.

**You cannot retype a weight once the line is on the order.** Selecting a weighed line and tapping
**Qty** will not change it: *This weight was measured — it cannot be retyped.* A weight is a
measurement, and the numpad is not an instrument.

If you got it wrong, there are two ways out and both are quick:

- **Weigh it again** — tap the product and weigh properly. That adds a second line.
- **Remove the line** — select it and backspace on an empty numpad, then start over.

If the kitchen has already been sent the line, removing it sends them a cancellation, so they know.

## What the manager sets

In the back office, under the till's **Connected devices**, *Electronic scale* decides whether this
till looks for one. With it off, every weighing on that till is entered by hand.
