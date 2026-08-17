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
  - REG-208
  - REG-209
  - REG-212
  - REG-216
  - REG-217
  - REG-218
  - REG-219
  - REG-220
  - RST-104
  - RST-105
  - RST-107
  - RST-111
  - REG-337
  - RST-125
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

## Put it on a customer's account

A regular can settle later instead of paying now. Tap the on-account method; the order closes and
the amount goes on their tab rather than in the drawer.

**It needs a customer on the order.** Without one there is nobody to bill, so the till refuses —
attach the customer first.

### Settle a tab

From the customer's record, take the money and clear what they owe. Three things to know:

- **Cash only, for now.** Money settled any other way would be taken without the shift counting it,
  so the till refuses rather than losing track of it.
- **It needs an open shift**, because the cash has to land in a drawer that someone will count.
- **It is recorded as a cash movement**, named after the customer — so the end-of-shift count
  includes it and the reason is on the drawer ledger.

Paying more than is owed is allowed: the balance simply goes below zero and the house owes them.

> Settling needs a connection. Putting a sale *on* a tab works offline like any other payment —
> taking money *off* one does not, because two tills must not both decide what a balance became.

## One-tap payment from the product screen

If the back office has turned it on, common payment methods appear as buttons on the product
screen. One tap settles the order and goes straight to the receipt — no trip to this screen.

Only methods that can complete in a single tap are offered. A card terminal has a conversation to
hold, a gift card needs an amount, and an on-account sale needs a customer — none of those can be
one tap, so they are not offered as one.

**In a restaurant, the unsent-changes prompt still applies.** Paying in one tap is the easiest way
to settle for food the kitchen was never told about, so the same question is asked.

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
| A cash amount must be one the drawer can make | Round the cash line to a real coin |
| That is more than a thousand times the total | Confirm if it is genuine, or correct the amount |

**Payment lines that are not really tenders are dropped before the sale goes through** — a line
opened and left at zero, or a card line still waiting for the terminal. You do not need to tidy them
up first, and an order whose only tender is still waiting will not settle.

> Validating writes the sale to the device *before* moving to the receipt. If the till dies at that
> exact moment the sale is already safe. It is the one moment worth the half-second wait.

## After the receipt is printed

**Payments cannot be changed once the receipt has been printed or the order has been sent.** The
paper and the record have to agree — restating a €40 cash tender as €30 afterwards is exactly the
kind of adjustment the system exists to prevent.

If something is genuinely wrong after the fact, the answer is a [refund](refunds.md), which leaves
a trail, rather than an edit, which does not.

## Cancelling a card payment

If a payment has been sent to the terminal and not yet completed, the line cannot simply be
deleted — the till has no way to know whether the terminal took the money.

**Cancel it on the terminal first**, then mark the line cancelled here. The delete goes through once
the line says it took nothing.

## A payment method that has been removed

An order left open across a change to the till's settings can come back holding a payment method
the restaurant no longer accepts. Those lines are dropped when the payment screen opens; the amount
returns as owed and you tender it again with something that exists.

## Splitting a bill

Three ways, and the right one depends on what the table is asking for.

### By item

"She had the fish, I had the steak." Tap each line to move it — one unit per tap — onto a second
bill. Each bill then lists what that person actually ate, and prints its own correct total.

Once the second bill is paid, the till offers to go straight back to what is left rather than to a
blank order, so a table of six is six taps and six payments, not six searches for the same tab.

### Evenly

"Just split it four ways." Choose how many, and the till shows each share. Take them in whatever
order the cards come across the counter.

The shares always add up to exactly the bill. Where it does not divide cleanly the odd penny goes to
whoever pays first, so the last person is never left with the larger amount.

### By amount

"Put twenty on this card." Type the amount and take it. Whatever is left stays on the bill for the
next person.

You cannot take more than is outstanding — typing more simply settles it, rather than making change
against a table that has not finished paying.

### What is happening underneath

Splitting **by item** makes a second bill. Splitting **evenly** or **by amount** does not: the bill
stays whole and you collect several payments against it. That is deliberate — four people halving a
table do not each own a quarter of a pizza, and inventing four part-bills would put tax figures on
paper that match nothing anybody ordered.

Practically, it means the running total you see is always the real remaining balance.

## When the till will not let you validate

Validation is blocked, with the reason on screen, when:

- **the order is empty** — nothing to sell
- **not enough has been tendered** — the balance is still owed
- **a payment method needs a customer** and none is set
- **the service mode needs the customer** — a delivery or collection preset has to know who and
  where, and you are asked while they are still in front of you rather than after the money is
  counted
- **cash does not match the rounding rule**, or change is due on a till with no cash method

Set the missing thing and validate again. Nothing is lost in the meantime.

## Tips

A tip is added **after** the sale is settled — that is what a tip is — so the till lets one onto a
closed order even though nothing else about it can change.

Applying a tip does two things: it adds the tip to the order, and it raises the tender it was left
on, because that is what the card is actually charged. A €12.10 meal with a €2.00 tip becomes a
€14.10 sale paid €14.10, not a €14.10 sale that still owes €2.00.

**Which tender it lands on.** Card, and where a bill was split across two cards, the larger one. A
cash tip needs no adjustment — the money is already in the drawer and the count will find it.

**What the till will not do.** It will not reduce a payment after the receipt has printed, will not
move a settled payment from card to cash, and will not raise a tender by more than the tip you
entered. Those are the same protections that keep a printed receipt and the drawer honest; every
refused attempt is recorded.

Your register must have tipping and after-payment tipping switched on for any of this to be offered.
