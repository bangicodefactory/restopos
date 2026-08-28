---
title: Staff
audience: manager
features:
  - BOF-117
  - BOF-118
  - BOF-120
---

# Staff

**Back office → Staff.** Everyone who logs in at a till is here. Until recently the list was
whatever the system was installed with — you could edit someone and not add or remove anyone — so
this page is where hiring and leaving now happen.

## Hire someone

Fill in the name, pick a role, and press **Hire**. That is all it takes to get them into the system.

The PIN and the badge are set afterwards, on their own record. That is deliberate: both are
credentials, and a hiring form that asks for a PIN tends to end up written down next to the name.

## Set a PIN

Open the person's record and type a new PIN. You will never see an existing one — the system stores
only a one-way hash of it, so a lost PIN is replaced, not looked up.

A PIN must be **4 to 12 digits**, and the system refuses:

- **the same digit repeated** — `0000`, `7777`. Anyone who watches the keypad once has it.
- **a run of digits** — `1234`, `4321`, `9876`.
- **a PIN a colleague already uses.**

That last one is not about the till confusing two people; it never does, because the cashier picks
their name before typing anything. It is about what the records say afterwards. The PIN is what
signs a void, a price override and a drawer count that came up short — and if two people can each
type the other's PIN, the answer to "who did this" stops being worth anything.

## What a role means, and what a register can change about it

A person's **role** decides what they may do at a till: whether they can discount a line, void
something already sent to the kitchen, or close a session that is short.

The venue's roles are listed above the matrix, and you can add your own. Three ship with the
product — minimal, cashier, manager — and they can be renamed and re-granted but not removed, because
every staff record and register assignment names one of them and a new hire starts on cashier.

### Adding a role

**New role** asks for a display name and an identifier. The name is what staff see; the identifier is
what every assignment stores and it **cannot be changed afterwards**, so it is worth reading before
you save. It is filled in from the name and you can edit it.

A new role starts with nothing granted. Tick what it may do in the matrix underneath.

### The matrix

Each tick is one permission for one role, saved as you click it — there is no save button, and no way
to be half-finished.

Some rows are greyed. Three permissions reach back into the back office — changing a register's
settings from the till, seeing margins, force-closing someone else's session — and granting one needs
the matching back-office permission. If you cannot grant it, someone who manages registers or reads
reports can.

Some rows are marked **not enforced yet**. Those permissions appear in the matrix and are granted
honestly, but no part of the product checks them today: ticking or unticking them changes nothing at
the till. They are listed rather than hidden so you are not left believing a restriction is in place.

### Removing a role

A role can only be removed once nobody holds it — neither as their own role nor as an assignment on a
register. Move those people first. The three built-in roles cannot be removed at all.

Those defaults are the same across the whole venue.

**A single register can be different.** On that register's settings page, under Assignments, you can:

- give each attached person an **access level for that register only** — the same cashier can be
  extended on the main till and standard on the terrace one; and
- switch on **Abilities specific to this register** and untick individual abilities.

Turn the override on and it starts from the venue defaults, so you are adjusting rather than
starting from nothing. Turn it off and the register goes back to following the defaults — which is
not the same as ticking nothing. **Ticking nothing means that role can do nothing on this register**,
and the system keeps those two apart on purpose.

This is how you express "the closing manager on till 3 can void, nobody else can" without changing
what anyone can do anywhere else.

## Remove someone

Open their record and use **Remove**.

**Anyone who has taken an order or opened a session cannot be removed**, and the message says how
many. Their name is attached to every sale they rang up and every drawer they counted; deleting the
row would leave those records pointing at nobody.

**Deactivate them instead.** They disappear from every till's login list immediately, and every past
sale, report and audit entry keeps their name. This is what you want for someone who has left.
