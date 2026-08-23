---
title: What a register sends to the kitchen
audience: manager
features:
  - BOF-039
  - BOF-120
---

# What a register sends to the kitchen

A register's **Kitchen** settings decide what it sends and where. Its **Payments** settings decide
what gets counted at the end of the night. Two of those lists are shared across the venue, and this
page is about how sharing works, because it is the part that surprises people.

## Notes the register offers

Predefined notes are the one-tap notes staff pick instead of typing: *no ice*, *allergy — nuts*,
*fire together*. They are authored once, on the **Predefined notes** page, so the wording is
consistent — a typed "no nutz" matches nothing the kitchen scans for.

On a register's **Kitchen** tab you choose which of them that register offers. The rule reads
backwards from what most people expect, so it is worth stating plainly:

> **A note ticked here appears only on the registers that tick it. A note ticked nowhere appears
> everywhere.**

So a venue that never touches this list has every note on every till, which is what you want out of
the box. Tick *double shot* on the bar and it becomes the bar's note: it stops appearing on the
restaurant till. Untick it everywhere and it goes back to being available to all.

### The list is frozen during service

**While the register has a session open, its notes cannot be changed.** Close the session and the
change goes through.

That is not caution for its own sake. A predefined note is the wording the kitchen reads and, for an
allergy, acts on. Take one off at 8pm and the next order that needs it gets a free-typed
approximation, or nothing at all — while the orders already sent keep the text they were sent with.
The ticket in the pass and the picker at the till stop agreeing about what the venue's notes even
are, in the middle of service, which is the worst possible moment for it.

## Denominations the register counts

The coins and notes a register counts at close are chosen the same way, on the **Payments** tab, and
follow the same rule: one ticked nowhere is counted everywhere.

**These are not frozen during service.** The count sheet is read when the session closes, so noticing
at 6pm that a denomination is missing and fixing it straight away lands the correction on the count
that has not happened yet. Blocking it would mean waiting for the count you needed it for.

## Cashier badges

A badge is the barcode an employee scans to sign in. You set one on the employee's own card, and
**Print the badge** is available at that moment and only at that moment.

That is a property of how badges are stored rather than a missing feature: the system keeps only a
fingerprint of the badge, never the badge itself, so nobody — including the system — can read one
back. **A lost badge is reissued, not reprinted.** Type a new value, print it, hand it over; the old
one stops working the moment you save.

## Who can change this

All of it is register configuration and needs the same permission as the rest of the setup.
