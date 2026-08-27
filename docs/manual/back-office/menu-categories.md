---
title: Menu categories
audience: manager
features:
  - BOF-084
---

# Menu categories

Categories are how the menu is arranged on the till: the buttons a cashier taps to find a dish, and
the groupings a guest scrolls on the self-order screen. They nest, so *Drinks → Wine → Red* is three
levels of one branch.

A category is also what the rest of the system routes by. The kitchen printers fire on it, the
registers choose which parts of the menu to show by it, and pricelist rules can be attached to it —
so a category is rather more load-bearing than a label.

## Add a category

**Categories → New.** Give it a name and, if it belongs under something, a parent.

Everything else is optional and can be set now or later — the create and edit forms offer exactly the
same fields, so nothing has to be set twice:

- **Order** — where it sits among its siblings on the till. Drag a row, or use the up/down buttons.
- **Colour** — the button colour on the register.
- **Available from / until** — the hours it appears on the **self-order** menu. Set a breakfast
  category to 07:00–11:00 and guests stop being offered it at lunch. Leave both blank and it is
  always available.
- **Visible in self-ordering** — off hides it from guests entirely while leaving it on the till,
  which is what you want for staff-only items.

The window has to close after it opens. A 14:00–11:00 window is refused rather than stored, because
it is almost always two edits that met in the middle.

## Move a category

Change its **parent** and save. The whole branch moves with it: sub-categories keep their order,
their products, their printer routing and their pricelist rules.

That is worth saying plainly because it used not to be possible at all — moving a category meant
deleting it and building it again, which quietly threw all of those away.

**A category cannot be moved into its own branch.** The picker will not offer those choices, and the
till refuses if one is forced: a category filed under its own sub-category has no route back to the
top of the menu, so it stops appearing anywhere and any pricelist rule attached to it stops applying.

## Remove a category

Several things stop you, and the message says which:

- **It has sub-categories.** They would be deleted with it. Move them out first.
- **It still holds products.** Those products stay, but they drop off the menu entirely.
- **A kitchen printer routes on it.** Removing it unpicks that routing, so the dishes stop being
  sent to the pass and nothing says so.
- **A register shows it**, or **a pricelist rule is keyed to it.**

None of that is caution for its own sake. Every one of those links is removed *silently* by the
database when a category goes — the delete would report success and the damage would only show up at
the next service.

**Deactivate instead.** A deactivated category disappears from the tills and from the self-order
menu, and everything pointing at it stays exactly as it was. That is what "remove this category"
almost always means.

A category nothing points at is removed outright.

## Who can change this

Categories are register configuration and need the same permission as the rest of the setup. That is
newer than it sounds: until recently any signed-in account could restructure the menu that every till
in the venue browses.
