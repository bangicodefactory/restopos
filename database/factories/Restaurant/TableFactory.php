<?php

declare(strict_types=1);

namespace Database\Factories\Restaurant;

use App\Enums\TableShape;
use App\Models\Restaurant\Table;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<Table>
 *
 * `identifier` is the QR capability token the self-order PWA is reached with,
 * so it has to stay unique and URL-safe.
 */
class TableFactory extends Factory
{
    protected $model = Table::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $number = $this->faker->unique()->numberBetween(1, 9999);

        return [
            'uuid' => (string) Str::uuid(),
            'restaurant_floor_id' => Reference::restaurantFloorId(),
            'company_id' => Reference::companyId(),
            'table_number' => $number,
            'name' => 'T'.$number,
            'identifier' => strtoupper(Str::random(8)),
            'shape' => TableShape::Square->value,
            'position_x' => $this->faker->numberBetween(10, 800),
            'position_y' => $this->faker->numberBetween(10, 500),
            'width' => 80,
            'height' => 80,
            'seats' => $this->faker->numberBetween(2, 8),
            'active' => true,
        ];
    }

    public function round(): static
    {
        return $this->state(fn (): array => ['shape' => TableShape::Round->value]);
    }

    public function seats(int $seats): static
    {
        return $this->state(fn (): array => ['seats' => $seats]);
    }

    /** Physically snapped onto another table; their orders merge. */
    public function linkedTo(Table $parent): static
    {
        return $this->state(fn (): array => [
            'restaurant_floor_id' => $parent->restaurant_floor_id,
            'parent_id' => $parent->id,
        ]);
    }
}
