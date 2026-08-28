import io

p = 'docs/manual/back-office/staff.md'
s = io.open(p, encoding='utf-8', newline='').read()

old = """## What a role means, and what a register can change about it

A person's **role** — cashier, waiter, manager — decides what they may do at a till: whether they
can discount a line, void something already sent to the kitchen, or close a session that is short.

Those defaults are the same across the whole venue.
"""

new = """## What a role means, and what a register can change about it

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
"""

assert old in s, 'section anchor'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('manual updated')
