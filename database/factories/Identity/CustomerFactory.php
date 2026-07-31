<?php

declare(strict_types=1);

namespace Database\Factories\Identity;

use App\Enums\AddressType;
use App\Models\Identity\Customer;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Customer>
 */
class CustomerFactory extends Factory
{
    protected $model = Customer::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $name = $this->faker->name();

        return [
            'uuid' => (string) Str::uuid(),
            'company_id' => Reference::companyId(),
            'address_type' => AddressType::Contact->value,
            'is_company' => false,
            'name' => $name,
            'display_name' => $name,
            'email' => $this->faker->unique()->safeEmail(),
            'phone' => $this->faker->e164PhoneNumber(),
            'city' => $this->faker->city(),
            'zip' => $this->faker->postcode(),
            'locale' => 'fr_FR',
            'loyalty_points_cache' => 0,
            'order_count' => 0,
            'marketing_opt_in' => false,
            'active' => true,
        ];
    }

    public function company(): static
    {
        $name = $this->faker->company();

        return $this->state(fn (): array => [
            'is_company' => true,
            'name' => $name,
            'display_name' => $name,
            'vat' => 'FR'.$this->faker->numerify('###########'),
        ]);
    }
}
