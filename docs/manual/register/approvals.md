---
title: Cashier login and manager approvals
audience: manager
features:
  - REG-040
  - REG-042
  - REG-045
  - REG-046
  - REG-049
---

# Cashier login and manager approvals

## Signing in

Pick your name and enter your PIN before selling. Every order and every line is stamped with the
cashier who rang it, which is what makes the shift readable afterwards.

Switching cashier on a till with an **empty** order in progress re-owns that order rather than
leaving it attributed to whoever was there before.

### Auto-logout

The till locks itself after a few minutes idle — sooner on the login screen than mid-order. It is a
screensaver with a PIN, not a logout: nothing in progress is lost.

## What needs a manager

Some actions are gated. When one is attempted, the till asks for a manager's PIN **on the cashier's
device** — the manager does not need to go anywhere.

Typically gated:

- Editing a price by hand
- Editing a payment
- Reprinting a receipt that has already been printed
- Closing the till when the count is outside the allowed difference
- Creating a product from the till
- **A discount above the configured threshold**

Which of these apply, and to whom, is set per register in the back office.

## How approvals are checked

Worth understanding, because it explains what happens when something is refused.

An approval is not a local unlock. The till records who approved what, and **the server checks it
again** when the order is sent:

- the manager must be an employee of this register,
- they must actually hold the permission being claimed,
- and the same approval cannot be reused on a different order.

If any of those fail, the action is refused server-side even though the till accepted the PIN, and
the attempt is recorded against the cashier who pushed it — not against the manager whose name was
used. **A till claiming a permission its manager does not have is worth knowing about.**

### Asking for an override at the till

A cashier who cannot set a price sees the **Price** key marked with a lock rather than greyed out.
Tapping it asks for a manager: they pick their name, enter their PIN on the cashier's device, and
the key unlocks **for that line**.

Discounts work the other way round, because a cashier is entitled to discount up to the house
limit. Typing past it holds the line at the limit and offers **Ask a manager**; approving applies
the figure that was typed. Nothing changes if the manager is refused or walks away — the line stays
exactly as it was.

### One approval covers one line

When you approve an override on a particular line, that is the line it applies to. Approving a 90 %
discount on the wine does not let the rest of the order carry one; the other lines come back at the
normal limit, and the receipt shows what was actually applied.

If a whole order genuinely needs the override, approve each line. It is more taps, and it means the
record says what you actually agreed to rather than what the till inferred from it.

## The discount cap

Discounts above the register's limit need approval. The limit is a percentage, set per register.

**Refunds are exempt.** A refund credits what the original line was actually charged, including a
discount that was approved at the time. Re-applying the cap to a refund would either give back more
than was taken or less, depending on which way it was applied — so the original terms carry over
untouched.
