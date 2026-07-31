<?php

declare(strict_types=1);

namespace Database\Factories\Pos;

use App\Enums\PriceType;
use App\Models\Catalog\ProductVariant;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use Database\Factories\Catalog\ProductFactory;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<OrderLine>
 */
class OrderLineFactory extends Factory
{
    protected $model = OrderLine::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $variant = ProductVariant::query()->with('product')->inRandomOrder()->first();
        if ($variant === null) {
            ProductFactory::new()->withVariant()->create();
            $variant = ProductVariant::query()->with('product')->latest('id')->firstOrFail();
        }

        $order = Order::query()->latest('id')->first() ?? OrderFactory::new()->create();
        $price = (float) ($variant->list_price ?? $variant->product->list_price);

        return [
            'uuid' => (string) Str::uuid(),
            'pos_order_id' => $order->id,
            'company_id' => $order->company_id,
            'line_number' => 1,
            'product_variant_id' => $variant->id,
            'product_id' => $variant->product_id,
            'full_product_name' => $variant->display_name,
            'uom_id' => $variant->product->uom_id,
            'quantity' => 1,
            'price_unit' => $price,
            'price_extra' => 0,
            'price_type' => PriceType::Original->value,
            'discount_percent' => 0,
            'discount_amount' => 0,
            'price_subtotal' => $price,
            'price_subtotal_incl' => $price,
            // `none` marks a line with no tax; otherwise it is the dash-joined tax ids.
            'tax_signature' => 'none',
            'unit_cost' => $variant->standard_price,
            'total_cost' => $variant->standard_price,
            'margin' => 0,
            'refunded_quantity' => 0,
            'is_reward_line' => false,
            'points_cost' => 0,
            'is_edited' => false,
            'skip_preparation' => false,
        ];
    }

    public function quantity(float $quantity): static
    {
        return $this->state(fn (array $attributes): array => [
            'quantity' => $quantity,
            'price_subtotal' => (float) $attributes['price_unit'] * $quantity,
            'price_subtotal_incl' => (float) $attributes['price_unit'] * $quantity,
            'total_cost' => (float) $attributes['unit_cost'] * $quantity,
        ]);
    }

    public function discounted(float $percent): static
    {
        return $this->state(fn (array $attributes): array => [
            'discount_percent' => $percent,
            'discount_amount' => (float) $attributes['price_unit'] * (float) $attributes['quantity'] * $percent / 100,
        ]);
    }

    public function refundOf(OrderLine $original): static
    {
        return $this->state(fn (): array => [
            'refunded_order_line_id' => $original->id,
            'quantity' => -1 * (float) $original->quantity,
            'price_subtotal' => -1 * (float) $original->price_subtotal,
            'price_subtotal_incl' => -1 * (float) $original->price_subtotal_incl,
        ]);
    }
}
