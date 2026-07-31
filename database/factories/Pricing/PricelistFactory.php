<?php

declare(strict_types=1);

namespace Database\Factories\Pricing;

use App\Models\Pricing\Pricelist;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Pricelist>
 */
class PricelistFactory extends Factory
{
    protected $model = Pricelist::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'company_id' => Reference::companyId(),
            'currency_id' => Reference::currencyId(),
            'name' => 'Tarif '.$this->faker->unique()->word(),
            'sequence' => 10,
            'active' => true,
        ];
    }
}
