<?php

declare(strict_types=1);

namespace Database\Factories\Catalog;

use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<ProductVariant>
 */
class ProductVariantFactory extends Factory
{
    protected $model = ProductVariant::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $product = Product::query()->inRandomOrder()->first() ?? ProductFactory::new()->create();

        return [
            'uuid' => (string) Str::uuid(),
            'product_id' => $product->id,
            'company_id' => $product->company_id,
            'name_suffix' => null,
            'display_name' => $product->name,
            'default_code' => strtoupper(Str::random(8)),
            'barcode' => null,
            'price_extra' => 0,
            'list_price' => null,
            'standard_price' => $product->standard_price,
            'on_hand_qty' => 0,
            'self_order_available' => true,
            'is_active_combination' => true,
            'active' => true,
        ];
    }

    /** A priced attribute combination, e.g. a Large pizza. */
    public function withSuffix(string $suffix, float $priceExtra = 0.0): static
    {
        return $this->state(fn (array $attributes): array => [
            'name_suffix' => $suffix,
            'display_name' => ($attributes['display_name'] ?? 'Produit').' ('.$suffix.')',
            'price_extra' => $priceExtra,
        ]);
    }
}
