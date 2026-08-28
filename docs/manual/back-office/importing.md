---
title: Importing a catalogue
audience: manager
features:
  - BOF-093
---

# Importing a catalogue

Typing a 300-item menu in by hand is a day's work. This screen takes a spreadsheet instead.

It works in two steps and **the first one changes nothing**. You upload the file, read what would
happen to every line, and only then commit. Nothing is written until you press Import.

## Preparing the file

Save your spreadsheet as **CSV**. The first row must be the column names.

Pick what the file contains — products, POS categories, customers or taxes — and the screen tells you
three things about it:

- which columns are **required**
- which columns it **recognises** (anything else in your file is ignored, not an error)
- what a row is **matched on**, which is the important one; see below

**Download the empty template** and paste your data into it. The most common import failure by far is
a column name the importer does not recognise, and the template removes it entirely.

Excel is fine. It writes an invisible marker in front of the first column name that used to break
imports elsewhere; this one handles it.

## What "matched on" means

A row is not always a new record. Before creating anything, the importer looks for a record you
already have:

- a **product** is matched on its internal reference, then its barcode
- a **customer** on their card number, then email, then phone
- a **category** or a **tax** on its name

If it finds one, the row **updates** it. If it does not, the row **creates** one.

This is what makes correcting a file safe. Import 300 products, notice three prices are wrong, fix
those three rows and upload **the whole file again** — 297 rows update in place and three change.
You do not end up with 600 products.

Two consequences worth knowing:

- **A blank reference never matches anything.** A file of products with no references imports as new
  products every time, so give them references if you plan to re-import.
- **A category or tax is matched by name.** Renaming one in the file creates a second rather than
  renaming the first — rename those on their own screens.

## Reading the preview

Every line gets one of three outcomes:

- **Create** — no existing record matched
- **Update** — an existing record matched, and these values replace its own
- **Error** — the row cannot be imported, with the reason

The line number is the one in your spreadsheet, counting the header, so you can go straight to it.

The rows are exportable. If a long file has thirty errors, export the table and work through it in a
spreadsheet rather than scrolling.

## One bad row stops the whole file

If any line has an error, **nothing at all is written** — not even the good lines.

This is deliberate and it is the kinder failure. A half-imported catalogue leaves you with no way to
tell which half went in; you would fix the file, upload it again, and be relying entirely on the
matching to avoid a duplicate menu. Refusing the file means the outcome is always the one the preview
described.

Errors are the same ones you would get typing the record in by hand — the import uses exactly the
same rules as the screens do. A price the product form refuses is a price the import refuses, with
the same message.

## After importing products

An imported product is created ready to sell, but two things are worth checking:

- it lands in the venue's default **unit of measure**, because a CSV has no way to name one
- an imported **tax** lands in your first tax group

Both are easy to correct on the product's own screen, and neither can be expressed in a spreadsheet
sensibly enough to be worth a column.
