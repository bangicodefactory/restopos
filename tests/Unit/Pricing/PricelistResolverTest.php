<?php

declare(strict_types=1);

use App\Support\Pricing\Dto\PricelistContext;
use App\Support\Pricing\Dto\PricelistItem;
use App\Support\Pricing\PricelistResolver;

/**
 * Unit coverage for `app/Support/Pricing/PricelistResolver`
 * (docs/spec/04-tax-engine.md §10).
 *
 * Everything here is decimal **strings**: the resolver's output is rendered at
 * `Decimal::PRICE_SCALE` (4) and compared with `toBe`, i.e. `assertSame`, so a
 * float sneaking in fails the test rather than passing by coincidence.
 *
 * The corpus in `tests/fixtures/tax/059-074*.json` pins PHP against TypeScript;
 * this file pins the *branches* — precedence ranks, window edges, tie-breaks,
 * the recursion guards — that a shared fixture would be a clumsy way to reach.
 */

// ---------------------------------------------------------------- test helpers

/** A rule, with the resolver's own defaults for everything unstated. */
$item = static fn (array $overrides = []): array => \array_merge([
    'id' => 1,
    'appliedOn' => PricelistItem::APPLIED_GLOBAL,
    'computePrice' => PricelistItem::COMPUTE_FIXED,
    'base' => PricelistItem::BASE_LIST_PRICE,
    'minQuantity' => '0',
    'sequence' => 10,
    'active' => true,
], $overrides);

/** The reference product: list 10.00, cost 6.00, category 5 under 4 under 3. */
$context = static fn (array $overrides = []): PricelistContext => PricelistContext::fromArray(\array_merge([
    'variantId' => 100,
    'productId' => 10,
    'categoryId' => 5,
    'categoryAncestry' => [5, 4, 3],
    'listPrice' => '10.0000',
    'standardPrice' => '6.0000',
    'priceExtra' => '0',
    'quantity' => '1',
    'date' => null,
], $overrides));

/** @param list<array<string, mixed>> $items */
$resolverWith = static fn (array $items): PricelistResolver => PricelistResolver::fromArray([
    ['id' => 1, 'items' => $items],
]);

// ------------------------------------------------------- §10.3 specificity rank

describe('applied_on precedence', function () use ($item, $context, $resolverWith): void {
    $tiers = static fn (array $only = []): array => \array_values(\array_filter([
        'global' => $item(['id' => 1, 'appliedOn' => 'global', 'fixedPrice' => '1.0000']),
        'category' => $item(['id' => 2, 'appliedOn' => 'pos_category', 'posCategoryId' => 5, 'fixedPrice' => '2.0000']),
        'product' => $item(['id' => 3, 'appliedOn' => 'product', 'productId' => 10, 'fixedPrice' => '3.0000']),
        'variant' => $item(['id' => 4, 'appliedOn' => 'variant', 'productVariantId' => 100, 'fixedPrice' => '4.0000']),
    ], static fn (string $key): bool => \in_array($key, $only, true), ARRAY_FILTER_USE_KEY));

    it('lets a variant rule beat product, category and global', function () use ($tiers, $context, $resolverWith): void {
        $price = $resolverWith($tiers(['global', 'category', 'product', 'variant']))->resolve(1, $context());

        expect($price)->toBe('4.0000');
    });

    it('lets a product rule beat category and global', function () use ($tiers, $context, $resolverWith): void {
        $price = $resolverWith($tiers(['global', 'category', 'product']))->resolve(1, $context());

        expect($price)->toBe('3.0000');
    });

    it('lets a category rule beat global', function () use ($tiers, $context, $resolverWith): void {
        $price = $resolverWith($tiers(['global', 'category']))->resolve(1, $context());

        expect($price)->toBe('2.0000');
    });

    it('falls back to the global rule', function () use ($tiers, $context, $resolverWith): void {
        $price = $resolverWith($tiers(['global']))->resolve(1, $context());

        expect($price)->toBe('1.0000');
    });

    it('ignores a variant rule pointing at another variant', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['id' => 1, 'appliedOn' => 'global', 'fixedPrice' => '1.0000']),
            $item(['id' => 2, 'appliedOn' => 'variant', 'productVariantId' => 999, 'fixedPrice' => '4.0000']),
        ])->resolve(1, $context());

        expect($price)->toBe('1.0000');
    });

    it('walks the category ancestry nearest-first', function () use ($item, $context, $resolverWith): void {
        // Rank 2 for the own category (5), 3 for the parent (4), 4 for 3.
        $resolver = $resolverWith([
            $item(['id' => 1, 'appliedOn' => 'pos_category', 'posCategoryId' => 3, 'fixedPrice' => '30.0000']),
            $item(['id' => 2, 'appliedOn' => 'pos_category', 'posCategoryId' => 4, 'fixedPrice' => '40.0000']),
            $item(['id' => 3, 'appliedOn' => 'pos_category', 'posCategoryId' => 5, 'fixedPrice' => '50.0000']),
        ]);

        expect($resolver->resolve(1, $context()))->toBe('50.0000');
        // Same rules, a product whose own category is the grandparent.
        expect($resolver->resolve(1, $context(['categoryAncestry' => [4, 3]])))->toBe('40.0000');
        expect($resolver->resolve(1, $context(['categoryAncestry' => [3]])))->toBe('30.0000');
    });

    it('ignores a category rule outside the ancestry', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['id' => 1, 'appliedOn' => 'pos_category', 'posCategoryId' => 77, 'fixedPrice' => '77.0000']),
        ])->resolve(1, $context());

        // No candidate at all ⇒ list price + extra (§10.4).
        expect($price)->toBe('10.0000');
    });
});

// ------------------------------------------------------------ §10.4 tie-breaks

describe('winner selection', function () use ($item, $context, $resolverWith): void {
    it('prefers the highest quantity break that the line reaches', function () use ($item, $context, $resolverWith): void {
        $resolver = $resolverWith([
            $item(['id' => 1, 'minQuantity' => '0', 'fixedPrice' => '10.0000']),
            $item(['id' => 2, 'minQuantity' => '5', 'fixedPrice' => '8.0000']),
            $item(['id' => 3, 'minQuantity' => '10', 'fixedPrice' => '6.0000']),
        ]);

        expect($resolver->resolve(1, $context(['quantity' => '10'])))->toBe('6.0000');
        expect($resolver->resolve(1, $context(['quantity' => '5'])))->toBe('8.0000');
        expect($resolver->resolve(1, $context(['quantity' => '4.999'])))->toBe('10.0000');
    });

    it('compares min quantity as a decimal, not a string', function () use ($item, $context, $resolverWith): void {
        $resolver = $resolverWith([
            $item(['id' => 1, 'minQuantity' => '0', 'fixedPrice' => '10.0000']),
            $item(['id' => 2, 'minQuantity' => '10.00', 'fixedPrice' => '6.0000']),
        ]);

        // "9" > "10.00" lexically; 9 < 10 numerically.
        expect($resolver->resolve(1, $context(['quantity' => '9'])))->toBe('10.0000');
        expect($resolver->resolve(1, $context(['quantity' => '10'])))->toBe('6.0000');
    });

    it('breaks a rank and quantity tie on sequence, then id', function () use ($item, $context, $resolverWith): void {
        expect($resolverWith([
            $item(['id' => 1, 'sequence' => 20, 'fixedPrice' => '20.0000']),
            $item(['id' => 2, 'sequence' => 5, 'fixedPrice' => '5.0000']),
        ])->resolve(1, $context()))->toBe('5.0000');

        expect($resolverWith([
            $item(['id' => 7, 'sequence' => 10, 'fixedPrice' => '7.0000']),
            $item(['id' => 3, 'sequence' => 10, 'fixedPrice' => '3.0000']),
        ])->resolve(1, $context()))->toBe('3.0000');
    });

    it('skips inactive rules', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['id' => 1, 'active' => false, 'fixedPrice' => '1.0000']),
        ])->resolve(1, $context());

        expect($price)->toBe('10.0000');
    });

    it('returns list price plus extra when no rule matches', function () use ($context, $resolverWith): void {
        $price = $resolverWith([])->resolve(1, $context(['priceExtra' => '2.5000']));

        expect($price)->toBe('12.5000');
    });
});

// ---------------------------------------------------------- §10.2 date windows

describe('date windows', function () use ($item, $context, $resolverWith): void {
    $windowed = static fn (): array => [
        $item([
            'id' => 1,
            'fixedPrice' => '5.0000',
            'dateStart' => '2026-03-01',
            'dateEnd' => '2026-03-31',
        ]),
    ];

    it('applies a rule inside its window', function () use ($windowed, $context, $resolverWith): void {
        expect($resolverWith($windowed())->resolve(1, $context(['date' => '2026-03-15'])))->toBe('5.0000');
    });

    it('includes both window bounds', function () use ($windowed, $context, $resolverWith): void {
        $resolver = $resolverWith($windowed());

        expect($resolver->resolve(1, $context(['date' => '2026-03-01'])))->toBe('5.0000');
        expect($resolver->resolve(1, $context(['date' => '2026-03-31'])))->toBe('5.0000');
    });

    it('rejects a rule before it starts and after it ends', function () use ($windowed, $context, $resolverWith): void {
        $resolver = $resolverWith($windowed());

        expect($resolver->resolve(1, $context(['date' => '2026-02-28'])))->toBe('10.0000');
        expect($resolver->resolve(1, $context(['date' => '2026-04-01'])))->toBe('10.0000');
    });

    it('treats a null bound as open-ended', function () use ($item, $context, $resolverWith): void {
        $openEnd = $resolverWith([$item(['id' => 1, 'fixedPrice' => '5.0000', 'dateStart' => '2026-03-01'])]);
        $openStart = $resolverWith([$item(['id' => 1, 'fixedPrice' => '5.0000', 'dateEnd' => '2026-03-31'])]);

        expect($openEnd->resolve(1, $context(['date' => '2099-01-01'])))->toBe('5.0000');
        expect($openEnd->resolve(1, $context(['date' => '2020-01-01'])))->toBe('10.0000');
        expect($openStart->resolve(1, $context(['date' => '2020-01-01'])))->toBe('5.0000');
        expect($openStart->resolve(1, $context(['date' => '2099-01-01'])))->toBe('10.0000');
    });

    it('skips the window check entirely when the context has no date', function () use ($windowed, $context, $resolverWith): void {
        expect($resolverWith($windowed())->resolve(1, $context(['date' => null])))->toBe('5.0000');
    });

    it('compares ISO-8601 timestamps lexically', function () use ($item, $context, $resolverWith): void {
        $resolver = $resolverWith([$item([
            'id' => 1,
            'fixedPrice' => '5.0000',
            'dateStart' => '2026-03-01T09:00:00Z',
            'dateEnd' => '2026-03-01T17:00:00Z',
        ])]);

        expect($resolver->resolve(1, $context(['date' => '2026-03-01T12:00:00Z'])))->toBe('5.0000');
        expect($resolver->resolve(1, $context(['date' => '2026-03-01T08:59:59Z'])))->toBe('10.0000');
        expect($resolver->resolve(1, $context(['date' => '2026-03-01T17:00:01Z'])))->toBe('10.0000');
    });
});

// ------------------------------------------------------------ §10.6 compute modes

describe('compute modes', function () use ($item, $context, $resolverWith): void {
    it('takes a fixed price verbatim, ignoring the base', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'fixed', 'fixedPrice' => '7.5000', 'base' => 'standard_price']),
        ])->resolve(1, $context());

        expect($price)->toBe('7.5000');
    });

    it('subtracts a percentage of the base', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'percentage', 'percentPrice' => '25']),
        ])->resolve(1, $context());

        expect($price)->toBe('7.5000');
    });

    it('treats a negative percentage as a markup', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'percentage', 'percentPrice' => '-10']),
        ])->resolve(1, $context());

        expect($price)->toBe('11.0000');
    });

    it('applies the formula discount then the surcharge', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'formula', 'priceDiscount' => '10', 'priceSurcharge' => '0.50']),
        ])->resolve(1, $context());

        // 10 − 10% = 9.00, + 0.50 = 9.50
        expect($price)->toBe('9.5000');
    });

    it('rounds BEFORE adding the surcharge', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'priceDiscount' => '7',
                'priceRound' => '0.10',
                'priceSurcharge' => '-0.01',
            ]),
        ])->resolve(1, $context(['listPrice' => '12.3700']));

        // 12.37 − 7% = 11.5041 → step 0.10 → 11.50 → −0.01 = 11.49
        // (surcharge first would give 11.4941 → 11.49 by luck; the .99 pricing
        // trick only works because the rounding happens first.)
        expect($price)->toBe('11.4900');
    });

    it('treats a zero price_round as a no-op', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'formula', 'priceDiscount' => '33.33', 'priceRound' => '0']),
        ])->resolve(1, $context());

        // 10 − 3.333 = 6.667 → rendered at scale 4
        expect($price)->toBe('6.6670');
    });

    it('clamps up to the minimum margin over the base', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'base' => 'standard_price',
                'priceDiscount' => '50',
                'priceMinMargin' => '1.0000',
            ]),
        ])->resolve(1, $context());

        // base 6.00 → −50% = 3.00, floor = 6.00 + 1.00 = 7.00
        expect($price)->toBe('7.0000');
    });

    it('leaves a price already above the minimum margin alone', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'base' => 'standard_price',
                'priceDiscount' => '-100',
                'priceMinMargin' => '1.0000',
            ]),
        ])->resolve(1, $context());

        // base 6.00 → +100% = 12.00 > floor 7.00
        expect($price)->toBe('12.0000');
    });

    it('clamps down to the maximum margin over the base', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'priceDiscount' => '-50',
                'priceMaxMargin' => '2.0000',
            ]),
        ])->resolve(1, $context());

        // base 10.00 → +50% = 15.00, cap = 10.00 + 2.00 = 12.00
        expect($price)->toBe('12.0000');
    });

    it('applies both margin clamps in min-then-max order', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'priceDiscount' => '90',
                'priceMinMargin' => '-2.0000',
                'priceMaxMargin' => '5.0000',
            ]),
        ])->resolve(1, $context());

        // 10 − 90% = 1.00 → floor 8.00 → cap 15.00 ⇒ 8.00
        expect($price)->toBe('8.0000');
    });

    it('ignores a zero margin as "unset"', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'priceDiscount' => '90',
                'priceMinMargin' => '0',
                'priceMaxMargin' => '0',
            ]),
        ])->resolve(1, $context());

        expect($price)->toBe('1.0000');
    });

    it('treats an unrecognised compute mode as the formula branch', function () use ($item, $context, $resolverWith): void {
        // Only `fixed` and `percentage` are special-cased; everything else — and
        // that includes a value a future migration has not taught this build
        // about — falls through to the formula path rather than blowing up mid-sale.
        $price = $resolverWith([
            $item([
                'computePrice' => 'something_new',
                'priceDiscount' => '10',
                'priceSurcharge' => '0.50',
            ]),
        ])->resolve(1, $context());

        expect($price)->toBe('9.5000');
    });
});

// ------------------------------------------------------------------ §10.5 base

describe('base price', function () use ($item, $context, $resolverWith): void {
    it('uses list price plus the attribute extra', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'percentage', 'percentPrice' => '10']),
        ])->resolve(1, $context(['priceExtra' => '2.0000']));

        // (10 + 2) − 10% = 10.80
        expect($price)->toBe('10.8000');
    });

    it('uses the standard price when asked, ignoring the extra', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'formula', 'base' => 'standard_price', 'priceDiscount' => '-25']),
        ])->resolve(1, $context(['priceExtra' => '99.0000']));

        // 6.00 + 25% = 7.50; the attribute extra never enters a cost base.
        expect($price)->toBe('7.5000');
    });

    it('resolves recursively through another pricelist', function (): void {
        $resolver = PricelistResolver::fromArray([
            ['id' => 1, 'items' => [[
                'id' => 1,
                'appliedOn' => 'global',
                'computePrice' => 'formula',
                'base' => 'pricelist',
                'basePricelistId' => 2,
                'priceDiscount' => '10',
                'minQuantity' => '0',
                'sequence' => 10,
            ]]],
            ['id' => 2, 'items' => [[
                'id' => 2,
                'appliedOn' => 'global',
                'computePrice' => 'percentage',
                'percentPrice' => '20',
                'minQuantity' => '0',
                'sequence' => 10,
            ]]],
        ]);

        $price = $resolver->resolve(1, PricelistContext::fromArray([
            'variantId' => 100,
            'productId' => 10,
            'categoryAncestry' => [5],
            'listPrice' => '10.0000',
            'standardPrice' => '6.0000',
        ]));

        // pricelist 2: 10 − 20% = 8.00; pricelist 1: 8.00 − 10% = 7.20
        expect($price)->toBe('7.2000');
    });

    it('re-evaluates the parent pricelist against the same context', function (): void {
        // The nested lookup must re-run rule selection, not just reuse a price:
        // pricelist 2 only has a rule at quantity ≥ 5.
        $resolver = PricelistResolver::fromArray([
            ['id' => 1, 'items' => [[
                'id' => 1,
                'appliedOn' => 'global',
                'computePrice' => 'formula',
                'base' => 'pricelist',
                'basePricelistId' => 2,
                'priceDiscount' => '0',
                'minQuantity' => '0',
                'sequence' => 10,
            ]]],
            ['id' => 2, 'items' => [[
                'id' => 2,
                'appliedOn' => 'global',
                'computePrice' => 'fixed',
                'fixedPrice' => '4.0000',
                'minQuantity' => '5',
                'sequence' => 10,
            ]]],
        ]);

        $ctx = static fn (string $qty): PricelistContext => PricelistContext::fromArray([
            'variantId' => 100,
            'productId' => 10,
            'listPrice' => '10.0000',
            'quantity' => $qty,
        ]);

        expect($resolver->resolve(1, $ctx('5')))->toBe('4.0000');
        expect($resolver->resolve(1, $ctx('1')))->toBe('10.0000');
    });

    it('falls back to the list price when base = pricelist has no target', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item([
                'computePrice' => 'formula',
                'base' => 'pricelist',
                'basePricelistId' => null,
                'priceDiscount' => '10',
            ]),
        ])->resolve(1, $context());

        expect($price)->toBe('9.0000');
    });

    it('rejects an unknown base', function () use ($item, $context, $resolverWith): void {
        expect(fn () => $resolverWith([$item(['computePrice' => 'formula', 'base' => 'moon_phase'])])
            ->resolve(1, $context()))
            ->toThrow(DomainException::class, 'unknown pricelist base "moon_phase"');
    });

    it('rejects an unknown pricelist id', function () use ($context, $resolverWith): void {
        expect(fn () => $resolverWith([])->resolve(404, $context()))
            ->toThrow(DomainException::class, 'unknown pricelist 404');
    });
});

// -------------------------------------------------------- §10.5 recursion guards

describe('recursion guards', function () use ($context): void {
    /** Chain n pricelists, each taking its base from the next. */
    $chain = static function (int $n, ?int $lastTarget): PricelistResolver {
        $lists = [];
        for ($i = 1; $i <= $n; $i++) {
            $lists[] = ['id' => $i, 'items' => [[
                'id' => $i,
                'appliedOn' => 'global',
                'computePrice' => 'formula',
                'base' => 'pricelist',
                'basePricelistId' => $i < $n ? $i + 1 : $lastTarget,
                'priceDiscount' => '0',
                'minQuantity' => '0',
                'sequence' => 10,
            ]]];
        }

        return PricelistResolver::fromArray($lists);
    };

    it('detects a cycle instead of hanging the till', function () use ($chain, $context): void {
        expect(fn () => $chain(2, 1)->resolve(1, $context()))
            ->toThrow(RuntimeException::class, 'cyclic pricelist base at 1');
    });

    it('detects a self-referencing pricelist', function () use ($chain, $context): void {
        expect(fn () => $chain(1, 1)->resolve(1, $context()))
            ->toThrow(RuntimeException::class, 'cyclic pricelist base at 1');
    });

    it('allows a chain up to the depth cap', function () use ($chain, $context): void {
        // 6 pricelists ⇒ depths 0..5, the last one falls back to the list price.
        expect($chain(6, null)->resolve(1, $context()))->toBe('10.0000');
    });

    it('rejects a chain past the depth cap', function () use ($chain, $context): void {
        expect(fn () => $chain(7, null)->resolve(1, $context()))
            ->toThrow(RuntimeException::class, 'pricelist base recursion exceeds 5');
    });
});

// ------------------------------------------------- §10.6.5 currency, §10.7 price type

describe('currency conversion', function () use ($item, $context, $resolverWith): void {
    it('multiplies the resolved price by the supplied rate', function () use ($item, $context, $resolverWith): void {
        $resolver = $resolverWith([$item(['fixedPrice' => '7.5000'])]);

        expect($resolver->resolve(1, $context(), '1.25'))->toBe('9.3750');
        expect($resolver->resolve(1, $context(), '1'))->toBe('7.5000');
    });

    it('defaults the rate to 1', function () use ($item, $context, $resolverWith): void {
        expect($resolverWith([$item(['fixedPrice' => '7.5000'])])->resolve(1, $context()))->toBe('7.5000');
    });

    it('rounds the converted price half-up at scale 4', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '10.0000'])])->resolve(1, $context(), '0.123456789');

        // 1.23456789 → half-up at 4 decimals
        expect($price)->toBe('1.2346');
    });

    it('converts an unrepriced manual price too', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '1.0000'])])
            ->resolve(1, $context(['priceType' => 'manual', 'priceExtra' => '2.0000']), '2');

        // (10 + 2) × 2 — the pricelist is skipped, the rate is not.
        expect($price)->toBe('24.0000');
    });
});

describe('price type', function () use ($item, $context, $resolverWith): void {
    it('never reprices a manual price', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '1.0000'])])
            ->resolve(1, $context(['priceType' => 'manual']));

        expect($price)->toBe('10.0000');
    });

    it('never reprices a barcode-embedded (automatic) price', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '1.0000'])])
            ->resolve(1, $context(['priceType' => 'automatic']));

        expect($price)->toBe('10.0000');
    });

    it('does reprice an original price', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '1.0000'])])
            ->resolve(1, $context(['priceType' => 'original']));

        expect($price)->toBe('1.0000');
    });
});

// ------------------------------------------------------------------ §10.6.4 scale

describe('output rendering', function () use ($item, $context, $resolverWith): void {
    it('always renders at PRICE_SCALE as a string', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([$item(['fixedPrice' => '8.125'])])->resolve(1, $context());

        expect($price)->toBeString()->toBe('8.1250');
    });

    it('does not currency-round: a 2-decimal currency may see 4 decimals', function () use ($item, $context, $resolverWith): void {
        $price = $resolverWith([
            $item(['computePrice' => 'percentage', 'percentPrice' => '33.33']),
        ])->resolve(1, $context());

        // 10 − 3.333 = 6.667 — the line, not the unit price, is currency-rounded.
        expect($price)->toBe('6.6670');
    });

    it('exposes the same value as a Decimal without rescaling', function () use ($item, $context, $resolverWith): void {
        $decimal = $resolverWith([$item(['fixedPrice' => '8.125'])])->resolveDecimal(1, $context());

        expect($decimal->toString())->toBe('8.125');
    });
});
