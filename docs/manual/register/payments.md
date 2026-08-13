---
title: Taking payment
audience: cashier
features:
  - REG-200
  - REG-201
  - REG-202
  - REG-203
  - REG-204
  - REG-205
  - REG-206
  - REG-216
  - REG-217
  - REG-218
  - REG-220
---

# Taking payment

The payment screen shows what is owed, what has been tendered so far, what is left, and the change
due. You settle an order by adding one or more payment lines until nothing remains.

## Take a single payment

Tap the payment method. The line is created for you and **pre-filled with the amount still owed**,
so an exact payment is two taps.

If the restaurant has only one payment method configured, it is selected automatically — there is
nothing to tap.

### Cash

Tapping a cash method opens the drawer. The quick-amount keys along the side offer the notes a
customer is likely to hand over; tap the one they gave you, or type the amount on the keypad.

### Change

Change is worked out for you and shown in large type. You do not create a change line — the system
records it against the sale automatically once the payment goes through.

**Change can only be given if a cash method exists.** If the restaurant takes card only, the till
refuses to settle an order for more than it costs, because there is nothing to give the difference
back from.

## Split a bill across methods

Add a payment line, set its amount to part of the total, then add another. Each line is
independently editable — tap it to select it, then use the keypad. Keep going until *Remaining*
reaches zero.

## Cash rounding

Where the smallest coin in circulation is larger than one cent, cash amounts are rounded to
something the drawer can actually make. Two consequences:

- A cash line pre-fills with the **rounded** amount, not the exact total.
- A card line pre-fills with the **exact** amount, because a terminal can charge any figure.

An order settled in cash can therefore close a couple of cents under the arithmetic total. That is
correct and expected, not a shortfall.

## Turn the change into a tip

If a customer says "keep the change", tap **Tip**. The change becomes a tip on the order instead of
money leaving the drawer.

## Validate the sale

**Validate** finishes the order: it is marked paid, written to the device, sent to the server and
the receipt is produced.

The till checks a few things first, and tells you which one failed:

| It says | What to do |
| --- | --- |
| The order is empty | Add a line, or leave the order |
| The order is not fully paid | The remaining amount is still owed |
| Change is due but no cash method is configured | Reduce the tender to the exact amount |
| This payment method needs a customer | Attach a customer, then validate |

**Payment lines that are not really tenders are dropped before the sale goes through** — a line
opened and left at zero, for instance. You do not need to tidy them up first.

> Validating writes the sale to the device *before* moving to the receipt. If the till dies at that
> exact moment the sale is already safe. It is the one moment worth the half-second wait.

## After the receipt is printed

**Payments cannot be changed once the receipt has been printed or the order has been sent.** The
paper and the record have to agree — restating a €40 cash tender as €30 afterwards is exactly the
kind of adjustment the system exists to prevent.

If something is genuinely wrong after the fact, the answer is a [refund](refunds.md), which leaves
a trail, rather than an edit, which does not.
