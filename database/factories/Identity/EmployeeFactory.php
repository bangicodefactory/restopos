<?php

declare(strict_types=1);

namespace Database\Factories\Identity;

use App\Enums\EmployeeRole;
use App\Models\Identity\Employee;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Employee>
 */
class EmployeeFactory extends Factory
{
    protected $model = Employee::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $barcode = '041'.$this->faker->unique()->numerify('##########');
        $pin = $this->faker->numerify('####');

        return [
            'company_id' => Reference::companyId(),
            'name' => $this->faker->name(),
            'job_title' => 'Caissier',
            'barcode' => $barcode,
            'barcode_hash' => hash('sha256', $barcode),
            // char(64): the schema stores a hex SHA-256 digest, never a bcrypt hash.
            'pin_hash' => hash('sha256', $pin),
            'default_role' => EmployeeRole::Cashier->value,
            'color' => $this->faker->numberBetween(0, 11),
            'active' => true,
        ];
    }

    public function withPin(string $pin): static
    {
        return $this->state(fn (): array => ['pin_hash' => hash('sha256', $pin)]);
    }

    public function manager(): static
    {
        return $this->state(fn (): array => [
            'default_role' => EmployeeRole::Manager->value,
            'job_title' => 'Responsable de salle',
        ]);
    }

    public function kitchen(): static
    {
        return $this->state(fn (): array => [
            'default_role' => EmployeeRole::Minimal->value,
            'job_title' => 'Cuisine',
        ]);
    }
}
