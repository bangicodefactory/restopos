---
title: Tills and devices
audience: manager
features: []
---

# Tills and devices

**Back office → Devices.** Every till, kitchen screen and customer display that has been paired to a
register is listed here, along with when it was last heard from.

## Pair a device

Open the register the device belongs to, go to **Devices**, and generate a pairing code. The code is
good for ten minutes and works once. Type it into the new device and it joins that register.

**The code decides what kind of device it is.** A code generated for a customer display can only
enrol a customer display — if the device asks to be enrolled as a till instead, the pairing is
refused. Generate the right kind of code rather than correcting it afterwards.

## Naming a device

Devices arrive named after their type and the order they were paired — "Register 2", "Register 3" —
which stops being useful the moment a venue has more than two.

Use **Rename** in the device list. The name is only for finding the device on this page; the till
itself does not show it. Renaming does not interrupt anything, and previously the only way to fix a
label was to revoke the device and pair it again, which meant walking to the terminal mid-service.

## Pairing the same machine again

Devices get re-paired for ordinary reasons — the browser storage was cleared, a tablet was reset, a
token was revoked and reissued. When that happens, **the same machine is recognised and keeps its
place in the list**, along with its number and the name you gave it. It does not appear twice.

That recognition depends on the device being able to identify itself. If it cannot, the list shows
**"Machine not identified"** next to it, and pairing it again will add a second entry rather than
reusing the first. If you see several entries you suspect are the same physical device, revoke the
ones that are no longer in use — a revoked device stops working immediately and the terminal in
front of you is unaffected.

## Which version a device is running

The **Version** column shows the build each device last reported. It is recorded when the device is
paired and refreshed every time it syncs, so it reflects what is running now rather than what was
installed originally.

**Last synced** tells you whether a device has actually sent its sales, as distinct from **Last
seen**, which only says it is switched on. A till that is seen but not syncing is the one to look at
after a busy service.

Each register can declare the minimum version its devices should be on, in its settings. Set it once
a venue has updated its tills; leave it alone and the system-wide default applies. This is
information for you, not a barrier — a device below the minimum keeps working and is flagged, rather
than being cut off mid-service.

## Revoking a device

**Revoke** kills a device's access immediately. Use it for a lost or stolen tablet, or a terminal
being retired.

It cannot be undone: the device must be paired again from scratch, with a new code. Its number is
never reissued, so nothing in your history ever points at two different machines.

If you only want a device out of the way for a while, **deactivate** it instead — it stops being
offered and can be brought back without a trip to the terminal.
