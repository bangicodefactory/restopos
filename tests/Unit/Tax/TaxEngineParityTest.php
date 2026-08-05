<?php

declare(strict_types=1);

use App\Support\Pricing\ComboPriceDistributor;
use App\Support\Pricing\Dto\ComboComponent;
use App\Support\Pricing\Dto\PricelistContext;
use App\Support\Pricing\PricelistResolver;
use App\Support\Tax\Dto\OrderInput;
use App\Support\Tax\TaxEngine;

/**
 * The PHP half of the parity harness — docs/spec/04-tax-engine.md §13,
 * docs/CONVENTIONS.md § "The tax-parity rule".
 *
 * Reads exactly the same fixture files as
 * `packages/domain/test/tax-parity.test.ts` and asserts **exact string
 * equality**. No tolerance, ever: every comparison below is between two PHP
 * strings, and `assertSame` (Pest's `toBe`) is used precisely because it would
 * reject an int or a float that merely looks equal. A `0.1 + 0.2` style drift
 * must fail here, not be papered over by `assertEquals`.
 */
const TAX_FIXTURE_DIR = __DIR__.'/../../fixtures/tax';

/**
 * @return array<string, array<string, mixed>> file name => decoded fixture
 */
$loadTaxFixtures = static function (): array {
    $files = \glob(TAX_FIXTURE_DIR.'/*.json');
    \sort($files);

    $fixtures = [];
    foreach ($files as $path) {
        $decoded = \json_decode((string) \file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        $fixtures[\basename($path)] = $decoded;
    }

    return $fixtures;
};

/** Assert one decimal-string field, and that it really is a string. */
$assertDecimal = static function (mixed $actual, mixed $expected, string $where): void {
    expect($actual)->toBeString("{$where} must be a decimal string, never a float");
    expect($expected)->toBeString("{$where} fixture value must be a decimal string, never a float");
    expect($actual)->toBe($expected, $where);
};

$fixtures = $loadTaxFixtures();

it('finds the shared fixture corpus', function () use ($fixtures): void {
    expect($fixtures)->toHaveCount(\count(\glob(TAX_FIXTURE_DIR.'/*.json')));
    expect(\count($fixtures))->toBeGreaterThanOrEqual(60);
});

foreach ($fixtures as $file => $fixture) {
    // §13 step 1 — pricelist resolution, when the fixture exercises it.
    if (isset($fixture['pricelist']) && \is_array($fixture['pricelist'])) {
        test("{$file}: resolves pricelist rules", function () use ($fixture, $assertDecimal): void {
            $resolver = PricelistResolver::fromArray($fixture['pricelist']['pricelists']);
            $expected = $fixture['expected']['pricelist'];

            expect($fixture['pricelist']['resolve'])->toHaveCount(\count($expected));

            foreach ($fixture['pricelist']['resolve'] as $i => $entry) {
                $price = $resolver->resolve(
                    (int) $entry['pricelistId'],
                    PricelistContext::fromArray($entry['context']),
                    (string) ($entry['rate'] ?? '1'),
                );

                expect($entry['id'])->toBe($expected[$i]['id']);
                $assertDecimal($price, $expected[$i]['price'], "pricelist[{$entry['id']}].price");
            }
        });
    }

    // §13 steps 3 and 4 — taxes per line, then the document totals.
    test("{$file}: computes taxes and totals", function () use ($fixture, $assertDecimal): void {
        $result = (new TaxEngine)->compute(OrderInput::fromArray($fixture));

        $expectedLines = $fixture['expected']['lines'];
        $actualLines = \array_map(static fn ($line) => $line->toArray(), $result->lines);

        expect($actualLines)->toHaveCount(\count($expectedLines));

        foreach ($expectedLines as $i => $expectedLine) {
            $actualLine = $actualLines[$i];
            $id = $expectedLine['id'];

            expect($actualLine['id'])->toBe($id);
            $assertDecimal($actualLine['priceUnit'], $expectedLine['priceUnit'], "line[{$id}].priceUnit");
            $assertDecimal($actualLine['priceSubtotal'], $expectedLine['priceSubtotal'], "line[{$id}].priceSubtotal");
            $assertDecimal($actualLine['priceTotal'], $expectedLine['priceTotal'], "line[{$id}].priceTotal");

            expect($actualLine['taxes'])->toHaveCount(\count($expectedLine['taxes']), "line[{$id}].taxes count");

            foreach ($expectedLine['taxes'] as $t => $expectedTax) {
                $actualTax = $actualLine['taxes'][$t];
                expect($actualTax['taxId'])->toBe($expectedTax['taxId'], "line[{$id}].taxes[{$t}].taxId");
                $assertDecimal($actualTax['base'], $expectedTax['base'], "line[{$id}].taxes[{$t}].base");
                $assertDecimal($actualTax['amount'], $expectedTax['amount'], "line[{$id}].taxes[{$t}].amount");
            }

            // Whole-line structural identity: catches an extra or renamed key.
            expect($actualLine)->toBe($expectedLine, "line[{$id}]");
        }

        $expectedTotals = $fixture['expected']['totals'];
        $actualTotals = $result->totals->toArray();

        foreach (['totalExcluded', 'totalTax', 'totalIncluded', 'roundedTotal', 'roundingDelta'] as $field) {
            $assertDecimal($actualTotals[$field], $expectedTotals[$field], "totals.{$field}");
        }

        expect($actualTotals['taxGroups'])->toHaveCount(\count($expectedTotals['taxGroups']), 'totals.taxGroups count');

        foreach ($expectedTotals['taxGroups'] as $g => $expectedGroup) {
            $actualGroup = $actualTotals['taxGroups'][$g];
            expect($actualGroup['taxGroupId'])->toBe($expectedGroup['taxGroupId'], "taxGroups[{$g}].taxGroupId");
            $assertDecimal($actualGroup['base'], $expectedGroup['base'], "taxGroups[{$g}].base");
            $assertDecimal($actualGroup['amount'], $expectedGroup['amount'], "taxGroups[{$g}].amount");
        }

        // Whole-totals structural identity.
        expect($actualTotals)->toBe($expectedTotals, 'totals');
    });
}

/*
 * §13 step 2 — combo price distribution.
 *
 * This was a `->skip()` placeholder: the TypeScript half asserted `expected.combo` and PHP had no
 * distributor at all, so the combo half of every fixture went unverified on this side — which is
 * how the server came to silently reverse a combo discount (BAN-470). The corpus and the
 * expectations were already here; only the implementation was missing.
 */
foreach ($fixtures as $file => $fixture) {
    if (! isset($fixture['combo']) || ! is_array($fixture['combo'])) {
        continue;
    }

    test("{$file}: distributes the combo price", function () use ($fixture, $assertDecimal): void {
        $components = array_map(
            static fn (array $component): ComboComponent => ComboComponent::fromArray($component),
            $fixture['combo']['components'],
        );

        $prices = (new ComboPriceDistributor)->distribute(
            (string) $fixture['combo']['parentPrice'],
            $components,
            (string) ($fixture['combo']['precision'] ?? '0.01'),
        );

        $expected = $fixture['expected']['combo'];

        expect($prices)->toHaveCount(count($expected));

        foreach ($expected as $entry) {
            $assertDecimal($prices[$entry['id']] ?? null, $entry['priceUnit'], "combo[{$entry['id']}].priceUnit");
        }
    });
}
