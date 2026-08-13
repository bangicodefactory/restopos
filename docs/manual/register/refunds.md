---
title: Refunds
audience: cashier
features:
  - REG-270
  - REG-271
  - REG-272
  - REG-273
  - REG-274
  - REG-276
---

# Refunds

A refund is always **against an earlier sale**. You cannot create money from nothing on the till —
every refund line points at the line it is giving back, which is what lets the system stop the same
item being refunded twice.

## Refund part of an order

1. Find the original sale on the [ticket screen](orders.md).
2. Choose **Refund**.
3. Set the quantity to give back on each line. Leave the rest at zero.
4. Confirm. A new order is created holding the negative lines.
5. Settle it like any other order — the total is negative, so this pays money out.

## Refund a whole order

From the ticket list, refund the entire sale in one action rather than setting each line by hand.

## What the till will not let you do

These are refused rather than warned about, because each one is a way for money to leave without a
matching sale.

- **Refund more than was sold.** Each original line tracks how much of it has already been given
  back, across every refund, including ones taken on another till. The remaining quantity is what
  you can refund.
- **Add a positive line to a refund.** A refund cannot quietly become a sale.
- **Change the price or discount on a refund line.** The refund credits **what was actually
  charged** on the original line — including whatever discount was applied at the time. An item
  sold at 90% off refunds at 90% off.
- **Refund against more than one original order.** One refund, one source sale.

## Meal deals and combos

Refunding part of a combo gives back a proportional share of each item in it. You do not need to
work out how the deal price was split — refunding the deal refunds its parts together.

## What the customer sees

The refund produces its own receipt, referencing the original sale. Both documents stay in the
ticket list.

> If the original was paid by card, the money goes back the way it came. The till records the
> refund; returning the funds is the terminal's job and follows its own timing.
