---
title: Barcodes
audience: manager
features:
  - BOF-043
---

# Barcodes

**Back office → Barcodes.** Most shops never need this page. It matters if your shelf labels carry
more than a product code — a weight, a price, a batch — printed inside the barcode itself.

## Why a nomenclature exists

A supermarket that sells cheese by weight prints a barcode like `2100012015003`. That is not a
product code. It is:

- `21` — a prefix saying "this is a weighed item"
- `00012` — the product
- `01500` — 1.500 kg
- `3` — a check digit covering the whole thing

Scan that without a rule and the till looks for a product numbered `2100012015003`, finds nothing,
and beeps. **A nomenclature is what tells the till how to read the label**: which digits are the
product, which are the weight.

## Add a nomenclature and its rules

Give the nomenclature a name — "Weighed items", "Price-embedded" — then add rules to it.

Each rule needs a **pattern**, which is where the reading happens:

- **digits** match themselves. `21` means the code must start with 21.
- **`.`** matches any single character. `.....` is five digits of product code.
- **`{NNDDD}`** is a number embedded in the barcode: `N` whole digits, `D` decimals. `{NNDDD}` is
  two whole digits and three decimals — `01500` read as 1.500.

So the cheese label above is `21.....{NNDDD}`.

**The rule type** says what the embedded number *is* — a weight, a price, a discount. Getting this
wrong is not a display problem: a weight read as a price charges 1.50 for the cheese.

## Order matters

Rules are tried in the order shown, and **the first one that matches wins.** If two rules could both
read a label, the one above decides.

New rules are added at the end for this reason. Adding one at the top would change how labels you
are already scanning are read, without touching those labels or saying anything about it.

## Standard nomenclatures

Some nomenclatures are marked **Standard**. These are the ordinary EAN-13 and UPC-A definitions,
shared by every venue on the system.

You can point a register at one, and most venues should. **You cannot edit one** — a change would
alter what every other venue scans, which is not yours to do. If you need something close to a
standard but not identical, make your own.

## Point a register at one

**Register settings → the register's barcode nomenclature.** Each register reads labels using the
nomenclature it is pointed at, so a shop floor till and a back-counter till can differ if they
genuinely scan different labels.

A nomenclature a register still uses cannot be removed. The system says how many registers are on it,
because removing it would leave those tills quietly failing to read weighed items with nothing on any
screen connecting the two events.
