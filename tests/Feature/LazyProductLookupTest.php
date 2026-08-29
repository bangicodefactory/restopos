<?php

declare(strict_types=1);

use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * REG-071 / BAN-421 — the server half of the register's scan-miss lookup.
 *
 * `GET /api/pos/products` shipped, was routed and was covered by one test that only asserted it
 * answered. Nothing had ever *used* it, and the two gaps that made it unusable both hid behind that:
 * it did not search variant barcodes (the client indexes them), and it returned no variants (a line
 * references a variant, not a template).
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make();
});

/** Give the fixture's Margherita variant a barcode of its own, with nothing on the template. */
function variantBarcode(PosFixtures $fx, string $barcode): void
{
    $fx->variant->forceFill(['barcode' => $barcode])->save();
    $fx->product->forceFill(['barcode' => null])->save();
}

it('finds a product by a barcode that only its variant carries', function (): void {
    // The defect this closes: the client indexes both `product_variants.barcode` and
    // `products.barcode`, so a variant-only code missed locally, went to the server, and came back
    // empty — the lazy fetch was dead on arrival at any venue whose barcodes live on the SKU.
    variantBarcode($this->fx, '5901234123457');

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=5901234123457')
        ->assertOk()
        ->assertJsonCount(1, 'records')
        ->assertJsonPath('records.0.id', $this->fx->product->getKey());
});

it('finds a product by a variant reference too', function (): void {
    $this->fx->variant->forceFill(['default_code' => 'MARG-XL'])->save();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=marg-xl')
        ->assertOk()
        ->assertJsonPath('records.0.id', $this->fx->product->getKey());
});

it('ships the variants of every product it returns', function (): void {
    // Without these the client has a product it can cache and cannot sell: `addLine` takes a variant
    // id. A page of records with no variants is the feature looking finished and doing nothing.
    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=margherita')
        ->assertOk();

    expect($response->json('variants'))->toHaveCount(1)
        ->and($response->json('variants.0.id'))->toBe($this->fx->variant->getKey())
        ->and($response->json('variants.0.product_id'))->toBe($this->fx->product->getKey())
        ->and($response->json('variants.0'))->toHaveKeys(['barcode', 'display_name', 'list_price']);
});

it('reaches products the bootstrap cap left behind', function (): void {
    // The whole point of a lazy fetch, and the trap inside it. `Product::posLoadScope` caps at
    // `limited_product_count` ordered favourite-first, so with a cap of one the drink is the only
    // product the bootstrap ships. `paginate` overrides that limit for the records — but a variant
    // query written as `ProductVariant::posLoadScope()` re-derives its product set through the
    // *capped* subquery, and the Margherita would come back with no variants: found, and unsellable.
    $this->fx->config->forceFill(['limited_product_count' => 1])->save();
    $this->fx->drink->forceFill(['is_favorite' => true])->save();

    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=margherita')
        ->assertOk();

    expect($response->json('records'))->toHaveCount(1)
        ->and($response->json('records.0.id'))->toBe($this->fx->product->getKey())
        ->and(collect($response->json('variants'))->pluck('id')->all())
        ->toBe([$this->fx->variant->getKey()]);
});

it('never returns another company’s product or its variants', function (): void {
    $other = PosFixtures::make();
    variantBarcode($other, '4006381333931');

    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=4006381333931')
        ->assertOk();

    expect($response->json('records'))->toBe([])
        ->and($response->json('variants'))->toBe([]);
});

it('returns no variants when nothing matched', function (): void {
    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=nothing-like-this')
        ->assertOk()
        ->assertJsonPath('records', [])
        ->assertJsonPath('variants', []);
});

it('does not let a variant barcode drag in a sibling product', function (): void {
    // `orWhereHas` is a join in disguise. Written against the wrong table alias it matches every
    // product that has *any* variant, which reads as "the search works" on a fixture with one
    // product and returns the whole catalogue on a real one.
    variantBarcode($this->fx, '5901234123457');

    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=5901234123457')
        ->assertOk();

    expect(collect($response->json('records'))->pluck('id')->all())
        ->toBe([$this->fx->product->getKey()]);
});

it('returns every variant of a matched product, not just the one that matched', function (): void {
    // A scan resolves to one SKU, but the client caches the product and indexes all its barcodes.
    // Sending only the matching variant would make the second SKU of the same product a miss
    // forever — each scan fetching the product again and still not finding it.
    $second = ProductVariant::query()->create([
        'uuid' => (string) Str::uuid(),
        'product_id' => $this->fx->product->getKey(),
        'company_id' => $this->fx->company->getKey(),
        'display_name' => 'Margherita XL',
        'barcode' => '4006381333931',
        'list_price' => '14.00',
        'standard_price' => '7.00',
        'active' => true,
    ]);

    $response = $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=4006381333931')
        ->assertOk();

    expect(collect($response->json('variants'))->pluck('id')->all())
        ->toContain($this->fx->variant->getKey())
        ->toContain($second->getKey());
});

it('still matches on the template barcode and name', function (): void {
    // The widening is additive. Losing either of the two columns the endpoint already searched would
    // be a silent regression for the cashier typing in the search box.
    $this->fx->product->forceFill(['barcode' => '8712345678905'])->save();

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=8712345678905')
        ->assertOk()
        ->assertJsonPath('records.0.id', $this->fx->product->getKey());

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=marg')
        ->assertOk()
        ->assertJsonPath('records.0.id', $this->fx->product->getKey());
});

it('excludes a product that is no longer sold in the pos', function (): void {
    variantBarcode($this->fx, '5901234123457');
    Product::query()->whereKey($this->fx->product->getKey())->update(['available_in_pos' => false]);

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/products?search=5901234123457')
        ->assertOk()
        ->assertJsonPath('records', []);
});
