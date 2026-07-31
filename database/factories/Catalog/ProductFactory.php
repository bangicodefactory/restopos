<?php

declare(strict_types=1);

namespace Database\Factories\Catalog;

use App\Enums\ProductType;
use App\Enums\SpecialKind;
use App\Models\Catalog\Product;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Product>
 */
class ProductFactory extends Factory
{
    protected $model = Product::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $name = ucfirst($this->faker->unique()->words(2, true));

        return [
            'uuid' => (string) Str::uuid(),
            'company_id' => Reference::companyId(),
            'name' => $name,
            'product_type' => ProductType::Consumable->value,
            'default_code' => strtoupper(Str::slug($name)),
            'barcode' => null,
            'uom_id' => Reference::uomId(),
            'list_price' => $this->faker->randomFloat(2, 2, 40),
            'standard_price' => $this->faker->randomFloat(2, 1, 15),
            'available_in_pos' => true,
            'self_order_available' => true,
            'to_weight' => false,
            'track_stock' => false,
            'allow_negative_stock' => true,
            'is_special' => false,
            'special_kind' => SpecialKind::None->value,
            'color' => $this->faker->numberBetween(0, 11),
            'pos_sequence' => $this->faker->numberBetween(0, 500),
            'is_favorite' => false,
            'has_image' => false,
            'attribute_count' => 0,
            'combo_count' => 0,
            'sale_ok' => true,
            'active' => true,
        ];
    }

    /** Sold by weight, priced per kilogram. */
    public function weighed(): static
    {
        return $this->state(fn (): array => ['to_weight' => true]);
    }

    /** A technical article: tip, global discount, loyalty reward, deposit. */
    public function special(SpecialKind $kind = SpecialKind::Tip): static
    {
        return $this->state(fn (): array => [
            'is_special' => true,
            'special_kind' => $kind->value,
            'product_type' => ProductType::Service->value,
            'list_price' => 0,
            'available_in_pos' => false,
            'self_order_available' => false,
        ]);
    }

    public function combo(): static
    {
        return $this->state(fn (): array => ['product_type' => ProductType::Combo->value]);
    }

    /** Create the single implicit variant an attribute-less product always has. */
    public function withVariant(): static
    {
        return $this->afterCreating(function (Product $product): void {
            ProductVariantFactory::new()->for($product, 'product')->create([
                'company_id' => $product->company_id,
                'display_name' => $product->name,
                'standard_price' => $product->standard_price,
            ]);
        });
    }
}
