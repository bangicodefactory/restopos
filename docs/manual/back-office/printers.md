---
title: Kitchen printers
audience: manager
features:
  - BOF-114
---

# Kitchen printers

Each printer is a station: the grill, the pass, the bar. What a printer prints is decided by the
product categories routed to it, so a fired course reaches the people who cook it and nobody else.

## Add a printer

**Printers → Add**. You need a name, and a connection kind:

- **Network (ESC/POS)** — the printer is on the venue's network. Give it an address and a port.
- **IoT box** — the printer is attached to a box that talks to the till. Give the box's address.
- **Epson ePOS** — an Epson printer that speaks its own protocol directly.
- **Browser** — printing through whatever the till's browser is set up to use.

The connection kind decides which address fields matter, so the form asks for the ones that apply
and leaves the rest alone. Change the kind later and the required fields change with it — useful when
a station moves from a shared IoT box onto the network of its own.

## Route categories to it

Tick the product categories this printer is responsible for. A course is printed at every station
that has one of its products routed to it, so a dessert can go to the pass and the bar at once if
that is how the kitchen works.

Ticking nothing means the printer prints nothing. If you want a station to receive everything, use
**Print all categories** instead of ticking every box — a category added next month is then included
automatically, rather than being quietly missed.

## Test it

**Test** queues a ticket for that printer. It is a real print job, not a ping: the only meaningful
test of a kitchen printer is a piece of paper coming out of it.

## Remove a printer

**Remove**. The till refuses while that printer still has tickets waiting, and says how many. Those
tickets are food waiting to be cooked, and the orders they belong to already say the kitchen was
told — deleting the station would take them with it and nobody would be looking for them.

Clear the queue, or wait for it to print, and the delete goes through.

## Who can change this

Configuring printers is a manager task. Someone who can see the kitchen can look at the list; adding,
changing or removing a station needs permission to manage it.
