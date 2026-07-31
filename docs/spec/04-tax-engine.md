# RestoPOS — Pricing & Tax Engine (normative specification)

> **Status:** normative. This document is the single source of truth for every monetary
> computation in RestoPOS. The two implementations —
> `app/Support/{Money,Tax,Pricing}` (PHP, server, authoritative) and
> `packages/domain/src/{money,tax,pricing}` (TypeScript, client, offline) — are
> line-by-line ports of the algorithms below and **must** agree to the last emitted digit.
>
> Every numbered step here is referenced from the code by its `§` number. A magic number in
> either engine that is not traceable to a numbered step is a review defect.
>
> The executable form of this document is `tests/fixtures/tax/*.json`. Any behavioural change
> requires (a) an edit here, (b) the same edit in both engines, (c) a fixture that would have
> failed before. See `docs/CONVENTIONS.md` § "The tax-parity rule".

**Related:** `docs/spec/03-architecture.md` §4 (why), `docs/spec/01-schema.md` §2.C (the tables
whose columns are consumed here), `docs/odoo-analysis/01-pos-backend.md` §1.3 / §4.9.

---

## Table of contents

- [§1 Conventions](#1-conventions)
- [§2 The money type](#2-the-money-type)
- [§3 Rounding](#3-rounding)
- [§4 Inputs](#4-inputs)
- [§5 Fiscal position mapping](#5-fiscal-position-mapping)
- [§6 Tax flattening and ordering](#6-tax-flattening-and-ordering)
- [§7 Per-line tax computation](#7-per-line-tax-computation)
- [§8 Order aggregation and rounding method](#8-order-aggregation-and-rounding-method)
- [§9 Cash rounding](#9-cash-rounding)
- [§10 Pricelist resolution](#10-pricelist-resolution)
- [§11 Combo price distribution](#11-combo-price-distribution)
- [§12 Output shape](#12-output-shape)
- [§13 Fixture corpus format](#13-fixture-corpus-format)
- [§14 Deliberate deviations from Odoo](#14-deliberate-deviations-from-odoo)

---

## 1. Conventions

**1.1** MUST / MUST NOT / SHOULD are RFC-2119.

**1.2** Every monetary or quantity value that crosses a boundary (JSON, DB, fixture, function
argument documented as "decimal") is a **decimal string**: an optional `-`, one or more digits,
optionally `.` and one or more digits. `"0"`, `"-0.05"`, `"12.1000"` are valid. `"1e3"`, `"+1"`,
`".5"`, `"1."` are **not** valid input and MUST be rejected.

**1.3** No IEEE-754 floating point value MAY appear anywhere on the computation path in either
engine. PHP uses `App\Support\Money\Decimal` (bcmath-backed); TypeScript uses
`packages/domain/src/money/decimal.ts` (`bigint`-backed). Neither engine may call `floatval`,
`(float)`, `parseFloat`, `Number()`, `Math.round`, `round()`, `**`, or `/` on a monetary value.

**1.4** The two engines MUST perform *the same operations in the same order*. Parity is achieved
by construction, not by luck: where this document prescribes an operation sequence, both ports
follow it literally even when an algebraically equivalent shortcut exists.

**1.5** Sign convention: a **sale** carries `documentSign = +1`, a **refund** `documentSign = -1`.
Quantities may additionally be negative (a returned line inside a sale). See §7.3.

---

## 2. The money type

### 2.1 Representation

**2.1.1** A `Decimal` is the triple `(negative: bool, unscaled: non-negative integer, scale: int ≥ 0)`
denoting the exact rational `(-1)^negative × unscaled × 10^-scale`.

**2.1.2** Zero MUST be normalised to `negative = false`. There is no negative zero.

**2.1.3** Trailing zeros are **significant for rendering only**; they are never trimmed
automatically. `"1.50"` has scale 2, `"1.5"` has scale 1; the two compare equal (§2.3.6) and
render differently.

**2.1.4** `toString()` renders `unscaled` with a decimal point inserted `scale` digits from the
right, zero-padded on the left as needed, prefixed with `-` iff `negative`. `scale = 0` renders
no decimal point.

**2.1.5** `MAX_SCALE = 12`. This is the *internal working scale*. No intermediate value may carry
more than 12 fractional digits (§2.2.3).

**2.1.6** `PRICE_SCALE = 4`. Unit prices are reported at scale 4, matching `decimal(16,4)` in the
schema (`docs/spec/01-schema.md` §2.C).

### 2.2 Operations

Let `a` have scale `sa`, `b` scale `sb`.

**2.2.1 `add(a, b)` / `sub(a, b)`** — exact. Result scale = `max(sa, sb)`. Because both operands
are already ≤ `MAX_SCALE`, the result is too; no clamping occurs.

**2.2.2 `mul(a, b)`** — exact product, natural result scale `sa + sb`, **then clamped** (§2.2.3).

**2.2.3 `clamp(x)`** — if `scale(x) > MAX_SCALE`, round `x` to `MAX_SCALE` fractional digits using
`HALF_UP` (§3.1). Otherwise return `x` unchanged. `clamp` is applied only after `mul`; `add`,
`sub` and `div` cannot exceed `MAX_SCALE` by construction.

**2.2.4 `div(a, b, scale, mode)`** — the exact quotient `a / b` rounded to `scale` fractional
digits with rounding `mode`. Division by zero is a programming error and MUST throw. The
default in this document, written `a / b`, is `div(a, b, MAX_SCALE, HALF_UP)`.

Implementation (identical in both engines):

```
div(a, b, scale, mode):
    # shift so the quotient of the unscaled integers already carries `scale` digits
    shift   = scale + b.scale - a.scale
    num     = a.unscaled * 10^max(shift, 0)
    den     = b.unscaled * 10^max(-shift, 0)
    q, r    = divmod(num, den)                  # non-negative integers
    neg     = a.negative XOR b.negative
    q       = applyRounding(q, r, den, neg, mode)   # §3.2
    return Decimal(neg and q != 0, q, scale)
```

**2.2.5 `negate`, `abs`, `isZero`, `signum`** — trivial, scale-preserving.

**2.2.6 `compare(a, b)`** — value comparison after aligning scales; returns −1 / 0 / +1.
`"1.50"` and `"1.5"` compare 0.

**2.2.7 `withScale(x, n, mode)`** — rescale to exactly `n` fractional digits, rounding with
`mode` when `n < scale(x)`, zero-extending when `n > scale(x)`.

---

## 3. Rounding

### 3.1 Modes

| Mode | Meaning |
|---|---|
| `HALF_UP` | ties away from zero. `2.5 → 3`, `−2.5 → −3` |
| `HALF_DOWN` | ties toward zero. `2.5 → 2`, `−2.5 → −2` |
| `HALF_EVEN` | banker's; ties to the nearest even digit. `2.5 → 2`, `3.5 → 4`, `−2.5 → −2` |
| `UP` | always away from zero. `2.1 → 3`, `−2.1 → −3` |
| `DOWN` | always toward zero (truncate). `2.9 → 2`, `−2.9 → −2` |

`HALF_UP` is the default everywhere unless a currency or a cash-rounding row says otherwise.
**Every mode is defined on the magnitude and then signed** — there is no `CEIL`/`FLOOR`, so
negative amounts round symmetrically to positive ones. This is what makes a refund the exact
negation of the sale that produced it (§7.3), and it is the single most common source of
cross-language divergence.

### 3.2 `applyRounding(q, r, den, neg, mode)`

`q` is the truncated quotient, `r` the remainder, `den` the divisor, all non-negative,
`r < den`.

```
if r == 0: return q
twice = 2 * r
switch mode:
    DOWN:      return q
    UP:        return q + 1
    HALF_UP:   return q + (twice >= den ? 1 : 0)
    HALF_DOWN: return q + (twice >  den ? 1 : 0)
    HALF_EVEN: if twice >  den: return q + 1
               if twice <  den: return q
               return q + (q is odd ? 1 : 0)
```

`neg` participates only in the sign of the result, never in the choice of direction.

### 3.3 Currency rounding — `roundToStep(x, step, mode)`

**3.3.1** A currency is `{ code, decimalPlaces, rounding, roundingMode }` where `rounding` is the
smallest representable increment as a decimal string (`"0.01"`, `"0.05"`, `"0.001"`) and
`roundingMode` is one of §3.1 (default `HALF_UP`).

**3.3.2** `roundToStep(x, step, mode)`:

```
if step.isZero(): return x
q = div(x, step, 0, mode)      # integer number of steps, rounded per `mode`
return mul(q, step)            # scale(result) == scale(step)
```

The two-step form (divide to an integer under the requested mode, then multiply back) is
normative. It is exact for every step, including `0.05`, and it never introduces a residue that
a later comparison could trip over.

**3.3.3** `currencyRound(x) = roundToStep(x, currency.rounding, currency.roundingMode)`.

**3.3.4** Rendering a money value to output uses `withScale(x, currency.decimalPlaces, HALF_UP)`.
For every sane currency `scale(currency.rounding) ≤ decimalPlaces`, so this only zero-extends.

---

## 4. Inputs

All fields below are the names used in DTOs, in TypeScript types, and in fixture JSON. Fixture
JSON uses **camelCase**; the mapping to the snake_case DB columns of `docs/spec/01-schema.md` is
given in the third column.

### 4.1 `Currency`

| Field | Type | DB column |
|---|---|---|
| `code` | string | `currencies.code` |
| `decimalPlaces` | int | `currencies.decimal_places` |
| `rounding` | decimal string | `currencies.rounding` |
| `roundingMode` | `half_up`\|`half_down`\|`half_even`\|`up`\|`down` | (config; default `half_up`) |

### 4.2 `TaxDefinition`

| Field | Type | DB column |
|---|---|---|
| `id` | int | `taxes.id` |
| `name` | string | `taxes.name` |
| `amountType` | `percent`\|`fixed`\|`division`\|`group` | `taxes.amount_type` |
| `amount` | decimal string | `taxes.amount` |
| `priceInclude` | bool | `taxes.price_include` |
| `includeBaseAmount` | bool | `taxes.include_base_amount` |
| `isBaseAffected` | bool (default `true`) | `taxes.is_base_affected` |
| `hasNegativeFactor` | bool (default `false`) | `taxes.has_negative_factor` |
| `sequence` | int | `taxes.sequence` |
| `taxGroupId` | int | `taxes.tax_group_id` |
| `childrenTaxIds` | int[] | `tax_children` |

Semantics:

- **`percent`** — `amount` is a percentage of the tax base.
- **`fixed`** — `amount` is a currency amount **per unit**; the line amount is `amount × |quantity|`.
  It is unaffected by the base.
- **`division`** — "percentage of price, tax included": the *price* is `base / (1 − amount/100)`.
  When excluded, the tax amount is `base / (1 − amount/100) − base`; when included, it is
  `base × amount/100` on the inclusive amount (§7.4).
- **`group`** — carries no amount of its own; it is replaced by `childrenTaxIds` during
  flattening (§6).
- **`priceInclude`** — the product's `price_unit` already contains this tax. The tax must be
  unwound out of the price before the base is known (§7.4).
- **`includeBaseAmount`** — *compounding forward*: this tax's amount joins the base of every
  **subsequent** (higher-sequence) tax.
- **`isBaseAffected`** — *compounding backward*: when `false`, this tax's own base ignores the
  amounts contributed by preceding `includeBaseAmount` taxes and uses the untouched line base
  instead. The two flags are independent and both are load-bearing.
- **`hasNegativeFactor`** — withholding-style: the tax's amount is computed positively and then
  negated. The reported `base` is unaffected.

### 4.3 `LineInput`

| Field | Type | Notes |
|---|---|---|
| `id` | string | opaque line key, echoed in the output |
| `quantity` | decimal string | may be negative |
| `priceUnit` | decimal string | already includes `price_extra`; may be negative |
| `discount` | decimal string | percent, `"10"` = 10 % off. Default `"0"` |
| `taxIds` | int[] | **before** fiscal-position mapping |
| `sign` | `"1"`\|`"-1"` (optional) | per-line override of `documentSign` |

### 4.4 `OrderInput`

| Field | Type | Notes |
|---|---|---|
| `currency` | `Currency` | §4.1 |
| `roundingMethod` | `round_per_line` \| `round_globally` | `companies.tax_calculation_rounding_method` |
| `taxes` | `TaxDefinition[]` | the catalogue; only ids referenced by lines are used |
| `lines` | `LineInput[]` | |
| `documentSign` | `"1"` \| `"-1"` | default `"1"` |
| `fiscalPosition` | `FiscalPosition`\|null | §4.5 |
| `cashRounding` | `CashRounding`\|null | §4.6 |

### 4.5 `FiscalPosition`

| Field | Type | DB |
|---|---|---|
| `id` | int | `fiscal_positions.id` |
| `name` | string | |
| `mappings` | `{ taxSrcId: int, taxDestId: int\|null }[]` | `fiscal_position_taxes` |

### 4.6 `CashRounding`

| Field | Type | DB |
|---|---|---|
| `rounding` | decimal string | `cash_roundings.rounding` |
| `method` | `half_up`\|`up`\|`down` | `cash_roundings.rounding_method` |
| `strategy` | `add_invoice_line`\|`biggest_tax` | (default `add_invoice_line`) |

---

## 5. Fiscal position mapping

Applied **before** any arithmetic, per line, to `LineInput.taxIds`.

**5.1** With no fiscal position, `taxIds` passes through unchanged.

**5.2** For each `srcId` in `taxIds`, in order:

```
rows = fiscalPosition.mappings where taxSrcId == srcId
if rows is empty:                         # unmapped taxes pass through
    emit srcId
else:
    for row in rows (in declaration order):
        if row.taxDestId is not null:
            emit row.taxDestId            # 1 -> N expansion is legal
        # taxDestId == null drops the tax (exemption)
```

**5.3** The emitted list is de-duplicated preserving **first** occurrence.

**5.4** The mapping is *not* transitive: a destination tax is never re-mapped.

---

## 6. Tax flattening and ordering

**6.1** Resolve each id in the (post-§5) list against the tax catalogue. An unknown id is a
programming error and MUST throw.

**6.2** Sort the resolved taxes by `(sequence ASC, id ASC)`.

**6.3** Flatten `group` taxes: replace a tax whose `amountType == 'group'` with its
`childrenTaxIds`, resolved and sorted by `(sequence ASC, id ASC)` among themselves, recursively.
A `group` tax contributes no amount and never appears in the output breakdown. Its own
`priceInclude` / `includeBaseAmount` flags are ignored; the children's flags govern.

**6.4** Recursion is bounded: `MAX_GROUP_DEPTH = 5`. A cycle, or exceeding the depth, MUST throw.

**6.5** After flattening, the list is de-duplicated on tax id preserving first occurrence, and
**re-sorted** by `(sequence ASC, id ASC)`. The resulting order is the **evaluation order** and is
referenced below by index `0 … n−1`.

---

## 7. Per-line tax computation

Given one `LineInput`, the flattened tax list `T[0..n-1]`, the currency and the rounding method.

### 7.1 Working rounding

```
roundLine(x) = roundingMethod == 'round_per_line' ? currencyRound(x) : x
```

Under `round_globally` no intermediate rounding happens at all; every per-line value stays at the
internal scale (§2.1.5) and rounding occurs exactly once, at the order level (§8.3).

### 7.2 Line amount

```
7.2.1   priceAfterDiscount = priceUnit × (1 − discount / 100)
7.2.2   lineAmount         = priceAfterDiscount × quantity
7.2.3   lineAmount         = roundLine(lineAmount)
```

`(1 − discount/100)` is computed as `div(discount, 100, MAX_SCALE, HALF_UP)` subtracted from
`1`. A discount of `"33.33"` yields the factor `0.666700000000`. Discounts are therefore always
applied **before** tax, on the unit price, never on the tax amount.

### 7.3 Sign extraction

```
7.3.1   naturalSign = lineAmount < 0 ? -1 : +1
7.3.2   outSign     = documentSign × (line.sign ?? +1) × naturalSign
7.3.3   magnitude   = |lineAmount|
7.3.4   absQuantity = |quantity|
```

Everything from §7.4 to §7.6 operates on **non-negative magnitudes**. `outSign` is applied once,
at §7.7, to every emitted number (base, each tax amount, subtotal, total). Consequence: a refund
is the exact negation of the corresponding sale, because rounding happened on the positive
magnitude (§3.1).

### 7.4 Descending pass — unwinding price-included taxes

This pass discovers the tax-**excluded** base hidden inside a tax-inclusive `magnitude`. It walks
the evaluation order **backwards** (highest sequence first).

```
7.4.1   base          = magnitude
        inclFixed     = 0
        inclPercent   = 0
        inclDivision  = 0
        checkpoint    = {}            # index -> Decimal
        storeCheckpoint  = true
        nextIsBaseAffected = true     # is_base_affected of the tax processed one step earlier

7.4.2   for i = n-1 downto 0:
            tax    = T[i]
            factor = tax.hasNegativeFactor ? -1 : +1

            if tax.includeBaseAmount and nextIsBaseAffected:
                base = recomputeBase(base, inclFixed, inclPercent, inclDivision)
                inclFixed = inclPercent = inclDivision = 0
                storeCheckpoint = true

            if tax.priceInclude:
                if tax.amountType == 'percent':
                    inclPercent  = inclPercent  + tax.amount × factor
                elif tax.amountType == 'division':
                    inclDivision = inclDivision + tax.amount × factor
                elif tax.amountType == 'fixed':
                    inclFixed    = inclFixed    + absQuantity × tax.amount × factor

                if storeCheckpoint and tax.amount != 0:
                    checkpoint[i]   = base
                    storeCheckpoint = false

            nextIsBaseAffected = tax.isBaseAffected

7.4.3   totalExcluded = roundLine(recomputeBase(base, inclFixed, inclPercent, inclDivision))
```

with

```
7.4.4   recomputeBase(b, f, p, d):
            t = b - f                                 # remove per-unit fixed taxes
            t = div(t, 1 + p/100, MAX_SCALE, HALF_UP) # remove additive included percents
            t = t × (100 - d)
            t = div(t, 100, MAX_SCALE, HALF_UP)       # remove included division taxes
            return t
```

Two properties of §7.4.2 deserve emphasis, because they are exactly what distinguishes a correct
engine from a plausible one:

- **Included percent taxes accumulate additively, not multiplicatively.** Two included taxes of
  21 % and 2 % with no `includeBaseAmount` between them produce `base = magnitude / 1.23`, *not*
  `magnitude / 1.02 / 1.21`. `includeBaseAmount` is the only thing that makes taxes compound; it
  closes the accumulator and opens a new one.
- **`checkpoint[i]` records the inclusive total that tax `i` must reconstruct.** The first
  price-included tax met walking backwards (i.e. the *last* one in evaluation order within its
  compounding block) is given the checkpoint. In §7.5 that tax receives the residual rather than
  a freshly computed amount, which is what guarantees
  `totalExcluded + Σ includedTaxAmounts == magnitude` **exactly**. Without it, a `10.00`
  shelf price with 21 % included rings up as `9.99`.

### 7.5 Ascending pass — computing the tax amounts

```
7.5.1   base            = totalExcluded
        totalIncluded   = totalExcluded
        cumulatedIncl   = 0
        entries         = []

7.5.2   for i = 0 to n-1:
            tax    = T[i]
            factor = tax.hasNegativeFactor ? -1 : +1

            taxBase = (tax.priceInclude or tax.isBaseAffected) ? base : totalExcluded

            if tax.priceInclude and checkpoint has i:
                amount        = checkpoint[i] - (base + cumulatedIncl)
                cumulatedIncl = 0
                hadCheckpoint = true
            else:
                amount        = taxAmountExcluded(tax, taxBase, absQuantity)
                hadCheckpoint = false

            amount = roundLine(amount)
            amount = roundLine(amount × factor)

            if tax.priceInclude and not hadCheckpoint:
                cumulatedIncl = cumulatedIncl + amount

            entries.append({ taxId: tax.id, taxGroupId: tax.taxGroupId,
                             base: taxBase, amount: amount })

            if tax.includeBaseAmount:
                base          = base + amount
                cumulatedIncl = 0

            totalIncluded = totalIncluded + amount
```

with

```
7.5.3   taxAmountExcluded(tax, base, absQuantity):
            percent:  base × amount / 100
            fixed:    absQuantity × amount
            division: div(base, 1 - amount/100, MAX_SCALE, HALF_UP) - base
            group:    unreachable (flattened in §6.3)
```

Note that §7.5.3 always uses the **excluded** formula, even for a `priceInclude` tax: the
inclusive variant was already consumed by §7.4, and any inclusive tax that still needs a number
here is one that did not get a checkpoint, meaning its base is genuinely the excluded base.

`division` with `amount == 100` is a configuration error and MUST throw (division by zero).

### 7.6 Zero-quantity and zero-price lines

Fall out naturally: `magnitude == 0` gives `totalExcluded == 0` and every tax amount `0`. The
line is still emitted, with its tax breakdown, so that the receipt shows the tax group.

### 7.7 Signing and line output

```
7.7.1   priceSubtotal = outSign × totalExcluded
        priceTotal    = outSign × totalIncluded
        each entry.base   = outSign × entry.base
        each entry.amount = outSign × entry.amount
```

Rendered per §3.3.4 (money) and §2.1.6 (`priceUnit`).

---

## 8. Order aggregation and rounding method

**8.1** Lines are computed independently (§7) in input order.

**8.2 `round_per_line`.** Every per-line number was already rounded to the currency in §7.1.
Order totals are plain sums of the rounded parts:

```
totalExcluded = Σ line.priceSubtotal
totalTax      = Σ Σ entry.amount
totalIncluded = totalExcluded + totalTax
```

`totalIncluded == Σ line.priceTotal` holds by construction.

**8.3 `round_globally`.** Per-line values were kept unrounded. Rounding happens once, here:

```
8.3.1   rawExcluded = Σ line.totalExcluded (unrounded, signed)
8.3.2   for each distinct taxId, in first-appearance order:
            rawTaxAmount[taxId] = Σ entry.amount over all lines (unrounded, signed)
            rawTaxBase[taxId]   = Σ entry.base   over all lines (unrounded, signed)
8.3.3   totalExcluded = currencyRound(rawExcluded)
8.3.4   taxAmount[t]  = currencyRound(rawTaxAmount[t])
8.3.5   totalTax      = Σ taxAmount[t]
8.3.6   totalIncluded = totalExcluded + totalTax
```

Under `round_globally` the reported per-line values are `currencyRound` of the raw per-line
values, emitted for display only. **They are not guaranteed to sum to the order totals** — that
is the entire point of global rounding, and fixtures `060`/`061` pin the difference.

**8.4 Tax group summary.** Emitted in ascending `taxGroupId` order. For each group:

```
base   = Σ over all tax entries whose tax belongs to the group of entry.base
amount = Σ over the same entries of entry.amount
```

Under `round_per_line` the entries are already rounded; under `round_globally` the sums are taken
raw and `currencyRound` is applied once per group. A line carrying two taxes of the same group
contributes its base twice — deliberate, documented, and consistent between engines.

---

## 9. Cash rounding

Applied last, to the order total.

```
9.1   if cashRounding is null:
          roundedTotal  = totalIncluded
          roundingDelta = 0
      else:
          roundedTotal  = roundToStep(totalIncluded, cashRounding.rounding, cashRounding.method)
          roundingDelta = roundedTotal - totalIncluded
```

`method` maps to §3.1: `half_up → HALF_UP`, `up → UP`, `down → DOWN`. `UP`/`DOWN` are
away-from/toward **zero**, so a refund total of `−12.32` with `up` at `0.05` becomes `−12.35`,
mirroring the sale.

**9.2 Strategy `add_invoice_line`** (the default, and the only one Odoo permits in the POS):
totals and the tax breakdown are untouched; `roundingDelta` is carried as its own untaxed ledger
and receipt line.

**9.3 Strategy `biggest_tax`**: `roundingDelta` is added to the tax entry with the largest
absolute amount (ties broken by the lowest `taxGroupId`, then lowest `taxId`), to `totalTax`, and
`totalIncluded` becomes `roundedTotal`. If the order carries no tax at all, `biggest_tax`
degrades to `add_invoice_line`.

**9.4** `roundedTotal` and `roundingDelta` are always emitted, so the client can compute
`amountDue` per payment method without re-running the engine.

---

## 10. Pricelist resolution

Produces the `priceUnit` that §7.2 consumes. Evaluated per line.

### 10.1 Inputs

`PricelistContext`:

| Field | Type | Notes |
|---|---|---|
| `variantId` | int\|null | `product_variants.id` |
| `productId` | int\|null | `products.id` (template) |
| `categoryId` | int\|null | the product's POS category |
| `categoryAncestry` | int[] | `[own category, parent, grandparent, …]`, nearest first |
| `listPrice` | decimal string | `products.list_price` |
| `standardPrice` | decimal string | cost |
| `priceExtra` | decimal string | Σ `price_extra` of selected `no_variant` attribute values, default `"0"` |
| `quantity` | decimal string | drives `minQuantity` |
| `date` | ISO-8601 string\|null | drives the date window |

`PricelistItem` mirrors `pricelist_items` (§2.C): `id, pricelistId, appliedOn, productVariantId,
productId, posCategoryId, minQuantity, dateStart, dateEnd, computePrice, fixedPrice, percentPrice,
base, basePricelistId, priceDiscount, priceSurcharge, priceRound, priceMinMargin, priceMaxMargin,
sequence, active`.

### 10.2 Candidate filter

An item is a candidate iff **all** hold:

1. `active` is true;
2. `dateStart` is null or `dateStart ≤ date`;
3. `dateEnd` is null or `date ≤ dateEnd`;
4. `minQuantity ≤ quantity` (decimal comparison; `minQuantity` default `"0"`);
5. it matches the product by its `appliedOn` tier (§10.3).

If `date` is null, conditions 2 and 3 are skipped.

### 10.3 Specificity rank (lower wins)

| `appliedOn` | Matches when | Rank |
|---|---|---|
| `variant` | `productVariantId == ctx.variantId` | `0` |
| `product` | `productId == ctx.productId` | `1` |
| `pos_category` | `posCategoryId == ctx.categoryAncestry[k]` | `2 + k` |
| `global` | always | `2 + 1000` |

The ancestor walk is nearest-first: a rule on the product's own category beats a rule on its
parent category. `1000` is a sentinel larger than any realistic category depth; a `pos_category`
rule always beats `global`.

### 10.4 Winner

Sort candidates by `(rank ASC, minQuantity DESC, sequence ASC, id ASC)`; the first is the winner.
`minQuantity DESC` implements "the most specific quantity break wins". If there is no candidate,
the price is `listPrice + priceExtra` and resolution ends.

### 10.5 Base price

```
10.5.1  resolveBase(item, depth):
            if depth > MAX_PRICELIST_DEPTH (= 5):        throw
            switch item.base:
                'list_price':     return listPrice + priceExtra
                'standard_price': return standardPrice
                'pricelist':      if item.basePricelistId is null: return listPrice + priceExtra
                                  if item.basePricelistId is already on the resolution stack: throw
                                  return resolve(item.basePricelistId, depth + 1)
```

Cycle detection is by the set of pricelist ids currently on the stack. Odoo has neither the depth
cap nor the cycle check; both are required here (a cyclic pricelist otherwise hangs the till).

### 10.6 Computation

`price = resolveBase(item, depth)`, then:

```
10.6.1  fixed:       price = item.fixedPrice
10.6.2  percentage:  price = price - price × item.percentPrice / 100
10.6.3  formula:     priceLimit = price
                     price = price - price × item.priceDiscount / 100
                     if item.priceRound != 0:
                         price = roundToStep(price, item.priceRound, HALF_UP)
                     price = price + item.priceSurcharge
                     if item.priceMinMargin != 0:
                         price = max(price, priceLimit + item.priceMinMargin)
                     if item.priceMaxMargin != 0:
                         price = min(price, priceLimit + item.priceMaxMargin)
```

The order is normative and matches Odoo's `product.pricelist.item._compute_price`: **rounding
happens before the surcharge**, and the margins clamp against the *base* price, not against cost.

**10.6.4** The result is rendered at `PRICE_SCALE` (§2.1.6) with `HALF_UP`. It is **not**
currency-rounded — a pricelist may legitimately produce `8.1250` in a 2-decimal currency; §7.2.3
rounds the line, not the unit price.

**10.6.5** Currency conversion: if the pricelist currency differs from the order currency, the
result is multiplied by the supplied `rate` (default `"1"`) before §10.6.4.

### 10.7 `price_type`

A line whose `priceType` is `manual` or `automatic` is **never** repriced: pricelist resolution is
skipped entirely and `priceUnit` stands. Only `original` lines are recomputed when the pricelist
or the fiscal position changes.

---

## 11. Combo price distribution

A combo meal has one customer-facing price; the ledger needs it split across the component lines
so that each component carries its own taxes. The split must be exact: the components' unit
prices, times their quantities, must sum to the meal price **to the cent**.

### 11.1 Inputs

| Field | Type | Notes |
|---|---|---|
| `parentPrice` | decimal string | the meal's resolved unit price (§10) |
| `precision` | decimal string | rounding step, default `currency.rounding` |
| `components[]` | | in stepper order (`combos.sequence`, then `combo_items.sequence`) |
| `components[].id` | string | |
| `components[].comboBasePrice` | decimal string | `combos.base_price` of the owning choice group |
| `components[].quantity` | decimal string | picks of this item |
| `components[].extraPrice` | decimal string | `combo_items.extra_price`, default `"0"` |
| `components[].attributeExtra` | decimal string | Σ `price_extra` of chosen attribute values, default `"0"` |

### 11.2 Algorithm

```
11.2.1  originalTotal = Σ (comboBasePrice_i × quantity_i)

11.2.2  if originalTotal == 0:
            every component gets share_i = 0 except the last, which gets parentPrice
            (divided by its own quantity), then §11.2.4 applies. Done.

11.2.3  remaining = parentPrice
        for i = 0 .. m-1:
            share_i   = roundToStep(comboBasePrice_i × parentPrice / originalTotal,
                                    precision, HALF_UP)
            remaining = remaining - share_i × quantity_i
            if i == m-1:                       # last component absorbs the residue
                share_i   = share_i + div(remaining, quantity_i, PRICE_SCALE, HALF_UP)
                remaining = 0

11.2.4  priceUnit_i = share_i + extraPrice_i + attributeExtra_i
```

`comboBasePrice_i × parentPrice / originalTotal` is evaluated as
`div(mul(comboBasePrice_i, parentPrice), originalTotal, MAX_SCALE, HALF_UP)` and only then
rounded to `precision` — multiply first, divide second, round last. Reordering these three
operations changes the result by a cent and is a review defect.

**11.2.5** The residue lands on the **last** component in stepper order. This mirrors Odoo's
`computeComboItems` and is the reason a "Menu 9.99 = burger + drink" with equal base prices
splits `5.00 / 4.99` rather than `5.00 / 5.00` or `4.99 / 4.99`.

**11.2.6** The invariant `Σ (priceUnit_i − extraPrice_i − attributeExtra_i) × quantity_i ==
parentPrice` MUST hold exactly whenever every quantity is 1. With quantities > 1 the residue
division at `PRICE_SCALE` may leave a sub-cent remainder; §7.2.3 absorbs it at line level.

---

## 12. Output shape

```jsonc
{
  "lines": [
    {
      "id": "L1",
      "priceUnit": "12.1000",          // PRICE_SCALE (§2.1.6)
      "priceSubtotal": "26.30",        // tax-excluded, signed, currency scale
      "priceTotal": "32.67",           // tax-included, signed, currency scale
      "taxes": [
        { "taxId": 1, "base": "26.30", "amount": "5.85" },
        { "taxId": 2, "base": "26.83", "amount": "0.52" }
      ]
    }
  ],
  "totals": {
    "totalExcluded": "26.30",
    "totalTax": "6.37",
    "totalIncluded": "32.67",
    "roundedTotal": "32.65",           // §9
    "roundingDelta": "-0.02",
    "taxGroups": [
      { "taxGroupId": 1, "base": "26.30", "amount": "5.85" },
      { "taxGroupId": 2, "base": "26.83", "amount": "0.52" }
    ]
  }
}
```

Every value is a decimal string. `lines[].taxes` is in evaluation order (§6.5);
`totals.taxGroups` is in ascending `taxGroupId`.

---

## 13. Fixture corpus format

`tests/fixtures/tax/NNN-slug.json`, read by **both** `tests/Unit/Tax/TaxEngineParityTest.php`
and `packages/domain/test/tax-parity.test.ts`.

```jsonc
{
  "name": "003-compound-included",
  "description": "Human sentence explaining what this pins.",
  "specRefs": ["7.4.2", "7.5.2"],
  "currency":  { "code": "EUR", "decimalPlaces": 2, "rounding": "0.01", "roundingMode": "half_up" },
  "roundingMethod": "round_per_line",
  "documentSign": "1",
  "taxes": [ /* §4.2, all decimals as strings */ ],
  "fiscalPosition": null,                 // §4.5, optional
  "cashRounding": null,                   // §4.6, optional
  "pricelist": {                          // optional, §10
    "pricelists": [ { "id": 1, "items": [ /* §10.1 */ ] } ],
    "resolve":    [ { "id": "R1", "pricelistId": 1, "context": { /* §10.1 */ } } ]
  },
  "combo": {                              // optional, §11
    "parentPrice": "9.99",
    "precision": "0.01",
    "components": [ /* §11.1 */ ]
  },
  "lines": [ /* §4.3 */ ],
  "expected": {
    "pricelist": [ { "id": "R1", "price": "8.5750" } ],   // present iff `pricelist` is
    "combo":     [ { "id": "C1", "priceUnit": "5.0000" } ],// present iff `combo` is
    "lines":     [ /* §12 */ ],
    "totals":    { /* §12 */ }
  }
}
```

The harness in both languages performs exactly these steps, in this order:

1. If `pricelist` is present, resolve each `resolve[]` entry (§10) and compare to
   `expected.pricelist`.
2. If `combo` is present, distribute (§11) and compare to `expected.combo`.
3. Map every line's `taxIds` through `fiscalPosition` (§5).
4. Compute (§6–§9) and compare `expected.lines` / `expected.totals`.

Comparison is **exact string equality**, element by element. No tolerance, ever.

---

## 14. Deliberate deviations from Odoo

| # | Odoo | RestoPOS | Why |
|---|---|---|---|
| 14.1 | `round_globally` is emulated by rounding at `currency.rounding × 1e-5` | no intermediate rounding at all; exact decimals to `MAX_SCALE` | Odoo's `1e-5` is a float-era hack; exact arithmetic is strictly more precise and removes a whole class of parity bugs |
| 14.2 | `float_round` on IEEE doubles, `HALF_UP` implemented as `round(x + copysign(1e-12, x))` | exact integer remainder comparison (§3.2) | eliminates the "is `0.145` really `0.145`" class of bugs |
| 14.3 | pricelist base resolution recurses without bound | depth cap 5 + cycle detection (§10.5) | a cyclic pricelist hangs the till |
| 14.4 | cash rounding supports `biggest_tax` and `add_invoice_line`, POS forces `add_invoice_line` | both implemented (§9.2, §9.3) | back-office invoices may need `biggest_tax`; the POS default is unchanged |
| 14.5 | `computeComboItems` mutates the caller's configuration array to split a `qty > 1` tail | no mutation; the residue always lands on the last component (§11.2.5) | a pure function is testable; the observable split is the same for the cases the POS produces |
| 14.6 | tax repartition lines (`account.tax.repartition.line`) with arbitrary factors | a single `hasNegativeFactor` boolean (factor `+1` / `−1`) | `docs/spec/01-schema.md` §2.C drops repartition; the POS only ever sees the ±1 case |
