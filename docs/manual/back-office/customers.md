---
title: Customers
audience: manager
features:
  - BOF-119
---

# Customers

The customer list is where a regular's details are corrected, their tab is read, and two records of
the same person are put back together.

Until now the only place a customer existed was the register's picker: staff could create one mid-sale
and attach it to an order, and nothing could be changed afterwards. That is why duplicates
accumulate — they are made at the counter, in a hurry, and nobody notices.

## Finding someone

The search box looks at the name, email address, phone, mobile, VAT number and loyalty card, so a
customer can be found by whatever the person on the phone actually gives you.

Under the box, the screen says how many customers it is showing out of how many exist. If it says it
is showing 500 of 2,000, narrow the search — the list stops at 500 and will not tell you twice.

## What the list tells you

**Tab** is what the customer owes right now. It is only shown when it is not zero, so the two rows
that matter are not buried in a column of zeroes. A positive figure is money owed to the venue.

**Orders** and **Last visit** answer the two questions most often asked about a regular before you
pick up the phone to them.

## The record

Open a customer and the first row is the summary: tab, orders, last visit, loyalty points. **None of
these can be typed over**, and that is deliberate. The tab is the sum of the account moves listed
further down, and those moves are the record of what was actually charged and paid. If the figure
looks wrong, the answer is in the moves, not in the field.

### Commercial terms

Two settings here change what the customer is charged, automatically, from the moment they are
attached to an order at the till:

- **Default price list** — a members' rate, a trade tariff. This only applies on registers that have
  price lists switched on; a register configured to quote one price keeps quoting one price.
- **Fiscal position** — the tax treatment. This is the one to set for an exempt or export customer.

Both take effect at the counter with nothing further to do, so set them carefully and check the next
sale.

### Marketing consent

**Accepts marketing** cannot be switched on for a customer with neither an email address nor a
mobile number. There would be nothing to send to, and the record would still be counted among the
customers you can reach.

## Merging duplicates

When two records share an email address or a phone number, they appear at the top of the list under
**Likely duplicates**. Matching is on those shared details rather than on the name, because the name
is the thing that differs — that is how the duplicate was made.

To merge, **open the record you want to keep**. The one on screen survives: it keeps its name,
contact details, price list and fiscal position. Choose the other record from the list and confirm.

What moves onto the surviving record:

- every order and invoice
- every payment and cash movement
- **every account move** — and the tab is recalculated from them, so a debt on the duplicate is a
  debt on the survivor afterwards
- loyalty cards
- any delivery addresses or contacts filed under the absorbed record

The absorbed record is archived rather than deleted, with a note saying which record it went into.
It stops appearing at the till, and it is still there if the merge was a mistake.

**This cannot be undone from the screen.** Getting the direction wrong means the wrong name and the
wrong price list survive, so the confirm button names both records.

## Removing a customer

A customer with no orders and no account moves is deleted outright.

A customer with any history is **archived instead** — they disappear from the till and every past
order still names them. This is not a softer version of deleting: those orders are a legal record of
what was sold, and the customer's name is part of it. If you have been asked to erase someone,
archiving is the first step and the invoices are a separate conversation.
