---
title: Tax positions
audience: manager
features:
  - BOF-036
---

# Tax positions

**Back office → Tax positions.** A tax position changes which tax applies. Most venues need at least
one, and the reason is the same everywhere: **the same dish is taxed differently eaten in and taken
away**, and the difference is the tax authority's money either way.

## Set one up

Add a position and name it the way your staff will recognise it — "Takeaway", "Export", "Exempt".
Then add the mappings: for each tax you normally charge, say what it becomes.

A mapping reads left to right: **usual tax → becomes**. If your dine-in rate is 10% and your takeaway
rate is 5.5%, that is one mapping.

## Removing a tax entirely

Leave **Becomes** empty and the tax is **removed**, not left unchanged. This is what "exempt" and
"export" mean, and it is a deliberate choice rather than an unfinished row — the list shows it as
**Removed** so nobody has to guess.

## Applying automatically

Leave **Apply automatically** off and the position is chosen at the till by the cashier. That is the
right setting for takeaway, where it depends on what the customer wants and nothing on the record can
tell you.

Turn it on and set a country, and the position applies by itself when the customer's address matches
— which is the right setting for export, where it depends on a fact about the customer rather than a
choice at the counter.

## Removing a position

A position that has taxed any order cannot be removed, and the system says how many. Those orders
have to keep saying which regime they were taxed under — that is the record a tax inspection asks
for. **Deactivate it instead**: it stops being offered, and every past order keeps meaning what it
meant.

A position a register uses as its default cannot be removed either. Point the register somewhere else
first.

## If you set one of these up before and it seemed to do nothing

It did do nothing, and it was not your mistake.

The rule engine has always been correct, but the mappings never reached the tills — the till was
reading the wrong field name, so every mapping arrived empty and the ordinary tax was charged. There
was also no way to create a position in the first place, so this is unlikely to have affected you.

If you have positions that were set up directly in the database, they will start working as written
the next time your tills sync. **Check that they say what you meant** before a busy service.
