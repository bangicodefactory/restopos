---
title: RestoPOS user manual
audience: everyone
features: []
---

# RestoPOS user manual

How to run a service on RestoPOS — written for the people doing it, not for the people who built
it.

## Who each part is for

| Section | You are | What it covers |
| --- | --- | --- |
| [Opening and closing the till](register/sessions.md) | Cashier, manager | Starting a shift, the cash drawer, mid-shift readings, counting up |
| [Taking orders](register/orders.md) | Cashier | Adding items, changing an order, finding an earlier ticket |
| [Taking payment](register/payments.md) | Cashier | Cash, card, splitting a bill, change, validating a sale |
| [Refunds](register/refunds.md) | Cashier, manager | Giving money back against an earlier sale |
| [Manager approvals](register/approvals.md) | Manager | Approving discounts and overrides on the till |
| [Reading a kitchen ticket](kitchen/reading-a-ticket.md) | Kitchen | Where the food is going, what to make, and the marks that matter |
| [Notes on the kitchen screen](kitchen/notes.md) | Kitchen | Allergies and changes, including ones that arrive after the order was sent |

## Two things worth knowing before anything else

**The till keeps working when the internet does not.** Orders are stored on the device and sent up
when the connection returns. You can take a whole service offline. The one thing you cannot do
offline is anything that needs the server to arbitrate — closing a shift is the main one.

**The server has the final say on money.** The till shows a price and takes the payment, but the
totals recorded against the shift are recalculated centrally. If the two ever disagree — usually
because the till was offline while a price changed — the shift report shows the difference rather
than hiding it.

---

*This manual documents what is built. Features still in progress are absent rather than described
optimistically; if you cannot find something here, assume it does not exist yet and ask.*
