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

## Card terminals and QR payment

A method that talks to a card machine needs two things set, and they are different questions:

- **Terminal** — which *driver* the payment screen speaks. Adyen, Stripe, Viva and the rest.
- **Provider** — which configured account the money settles into. An online or QR method with no
  provider cannot take a payment at all: the till reports that the method has no provider and the
  customer's payment never starts.

**Terminal configuration** is the driver's own settings — a pairing id, a point-of-sale id, an
endpoint — as a set of keys, because every driver wants different ones.

**It is stored encrypted and never shown back to you.** The page will tell you a configuration
exists; it will not tell you what is in it, and neither will anything else. That is deliberate: it is
the credential that lets a terminal take money in your name, and a screen that can display it is a
screen that can leak it. Entering a new one replaces the old one completely — there is no editing
half of it.

For QR payment, choose the **QR standard** your country uses (EMVCo, SEPA, Swiss QR, Pix, UPI,
PromptPay) and, if your acquirer gave you one, the default payload the till builds its codes from.

## Logos

A payment method can carry an image, and there is currently **no way to give it one** — the system
can serve an image it already has, but nothing anywhere uploads one. The field is not shown rather
than shown greyed out, because a locked control suggests a permission you might be granted, and this
is a feature that does not exist yet.

## Changing a method mid-service

**While a session is open on a register that uses the method, only its position in the list can be
changed.** Everything else is frozen until close.

That is not caution for its own sake. The session's expected cash was worked out against the method
as it stood when the session opened. Flip *counts into the drawer* at lunchtime and the drawer that
balanced at 11am is short at close — with nothing on the report to explain why. Close the session
first and the change goes through.

## One cash method, one register

A cash method can belong to **one register only**. Try to add it to a second and the till refuses,
naming the register that already has it.

Two tills sharing a cash method means two drawers reconciling against the same money: each session
works out its own expected cash from that method, so a float or a cash movement on one till is
expected in the other's count. Nobody notices until a drawer comes up short, and by then the report
points at whoever was on it.

Card and other non-cash methods can be shared freely — they are reconciled against the acquirer, not
against a drawer.

## Remove a method

Once money has been taken through a method it cannot be removed, and neither can one that appears on
a closed session's report. Those figures are what a day's takings are reconciled against.

**Deactivate instead.** A deactivated method disappears from every till and every picker, and every
past sale and report stays exactly as it was. That is what "remove this method" almost always means.

A method nothing has been paid through is removed outright, and comes off the registers it was on.

## Who can change this

Payment methods are register configuration and need the same permission as the rest of the setup.

Changing a method's kind, its currency, its terminal or its provider is the same permission as
renaming it. The protections on this page are about **timing and consequence** — an open session, a
method money has gone through — not about who is allowed to look.
