<?php

declare(strict_types=1);

namespace Database\Factories\Pricing;

use App\Enums\TaxAmountType;
use App\Enums\TaxRoundingStrategy;
use App\Models\Pricing\Tax;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Tax>
 */
class TaxFactory extends Factory
{
    protected $model = Tax::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'company_id' => Reference::companyId(),
            'tax_group_id' => Reference::taxGroupId(),
            'name' => 'TVA 20 %',
            'description' => null,
            'amount_type' => TaxAmountType::Percent->value,
            'amount' => 20,
            'price_include' => false,
            'include_base_amount' => false,
            'is_base_affected' => true,
            'has_negative_factor' => false,
            'sequence' => 10,
            'rounding_strategy' => TaxRoundingStrategy::Inherit->value,
            'is_used' => true,
            'active' => true,
        ];
    }

    public function percent(float $rate, bool $priceInclude = false): static
    {
        return $this->state(fn (): array => [
            'name' => 'TVA '.rtrim(rtrim(number_format($rate, 2, ',', ''), '0'), ',').' %',
            'amount_type' => TaxAmountType::Percent->value,
            'amount' => $rate,
            'price_include' => $priceInclude,
        ]);
    }

    /** A per-unit contribution, e.g. packaging eco-participation. */
    public function fixed(float $amount, bool $priceInclude = false): static
    {
        return $this->state(fn (): array => [
            'name' => 'Contribution fixe',
            'amount_type' => TaxAmountType::Fixed->value,
            'amount' => $amount,
            'price_include' => $priceInclude,
        ]);
    }

    /** A container tax; attach children through the `children` relation. */
    public function group(): static
    {
        return $this->state(fn (): array => [
            'name' => 'Groupe de taxes',
            'amount_type' => TaxAmountType::Group->value,
            'amount' => 0,
        ]);
    }

    public function priceIncluded(): static
    {
        return $this->state(fn (): array => ['price_include' => true]);
    }
}
