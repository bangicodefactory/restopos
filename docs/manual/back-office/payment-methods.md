---
title: Payment methods
audience: manager
features:
  - BOF-110
---

# Payment methods

A payment method is a way of taking money: cash, a card terminal, a meal-voucher scheme, a customer
account. Each one decides how the till behaves when it is chosen.

## Add a method

**Payment methods → Add**. Three settings do the real work:

- **Kind** — cash, bank, card terminal, QR, online, customer account or voucher. This is what decides
  whether change can be given and whether the money is expected in the drawer at close.
- **Currency** — the unit the amount is in.
- **Terminal** — which card machine the payment screen talks to, if any.

Then the flags: whether it counts into the drawer, whether it identifies the customer, whether change
and refunds are allowed, and whether it is the one cash rounding lands on.

A new method is not on any till until you add it to that register's settings.

## Changing a method mid-service

**While a session is open on a register that uses the method, only its position in the list can be
changed.** Everything else is frozen until close.

That is not caution for its own sake. The session's expected cash was worked out against the method
as it stood when the session opened. Flip *counts into the drawer* at lunchtime and the drawer that
balanced at 11am is short at close — with nothing on the report to explain why. Close the session
first and the change goes through.

## Remove a method

Once money has been taken through a method it cannot be removed, and neither can one that appears on
a closed session's report. Those figures are what a day's takings are reconciled against.

**Deactivate instead.** A deactivated method disappears from every till and every picker, and every
past sale and report stays exactly as it was. That is what "remove this method" almost always means.

A method nothing has been paid through is removed outright, and comes off the registers it was on.

## Who can change this

Payment methods are register configuration and need the same permission as the rest of the setup.
