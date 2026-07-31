<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\TableShape;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Three floors and 24 tables laid out on a 900 × 620 canvas.
 *
 * Written with the query builder: the `App\Models\Restaurant\*` models are owned
 * by another workstream and this seeder must not depend on them landing first.
 *
 * `restaurant_tables.identifier` doubles as the QR capability token used by the
 * self-order PWA (`/menu/{token}`), so it is deterministic per table.
 */
class RestaurantSeeder extends Seeder
{
    public const FLOOR_MAIN = 'Salle principale';

    public const FLOOR_TERRACE = 'Terrasse';

    public const FLOOR_UPSTAIRS = 'Étage';

    public function run(): void
    {
        Demo::reseed('restaurant');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0 || DB::table('restaurant_floors')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());

        /** @var array<string, array{color: string, sequence: int, tables: list<array{0:int,1:string,2:TableShape,3:int,4:float,5:float,6:float,7:float,8:?string}>}> $floors */
        $floors = [
            self::FLOOR_MAIN => [
                'color' => '#F4EFE7',
                'sequence' => 1,
                'tables' => [
                    // number, name, shape, seats, x, y, w, h, colour
                    [1, 'T1', TableShape::Round, 2, 60, 60, 60, 60, '#C96F4A'],
                    [2, 'T2', TableShape::Round, 2, 160, 60, 60, 60, '#C96F4A'],
                    [3, 'T3', TableShape::Square, 4, 270, 50, 80, 80, '#8C1C13'],
                    [4, 'T4', TableShape::Square, 4, 390, 50, 80, 80, '#8C1C13'],
                    [5, 'T5', TableShape::Square, 4, 510, 50, 80, 80, '#8C1C13'],
                    [6, 'T6', TableShape::Round, 6, 640, 45, 100, 100, '#5B7553'],
                    [7, 'T7', TableShape::Square, 2, 60, 190, 60, 60, '#C96F4A'],
                    [8, 'T8', TableShape::Square, 2, 160, 190, 60, 60, '#C96F4A'],
                    [9, 'T9', TableShape::Square, 4, 270, 180, 80, 80, '#8C1C13'],
                    [10, 'T10', TableShape::Square, 4, 390, 180, 80, 80, '#8C1C13'],
                    [11, 'T11', TableShape::Round, 8, 520, 170, 120, 120, '#5B7553'],
                    [12, 'T12', TableShape::Square, 4, 680, 180, 80, 80, '#8C1C13'],
                ],
            ],
            self::FLOOR_TERRACE => [
                'color' => '#E8F1E4',
                'sequence' => 2,
                'tables' => [
                    [20, 'TE1', TableShape::Round, 2, 60, 60, 60, 60, '#5B7553'],
                    [21, 'TE2', TableShape::Round, 2, 150, 60, 60, 60, '#5B7553'],
                    [22, 'TE3', TableShape::Round, 2, 240, 60, 60, 60, '#5B7553'],
                    [23, 'TE4', TableShape::Round, 4, 340, 50, 80, 80, '#5B7553'],
                    [24, 'TE5', TableShape::Round, 4, 450, 50, 80, 80, '#5B7553'],
                    [25, 'TE6', TableShape::Square, 4, 560, 50, 80, 80, '#5B7553'],
                    [26, 'TE7', TableShape::Square, 6, 60, 190, 120, 80, '#3F5E3A'],
                    [27, 'TE8', TableShape::Square, 6, 210, 190, 120, 80, '#3F5E3A'],
                ],
            ],
            self::FLOOR_UPSTAIRS => [
                'color' => '#EDE7F4',
                'sequence' => 3,
                'tables' => [
                    [40, 'ET1', TableShape::Square, 4, 70, 70, 80, 80, '#6B4E9B'],
                    [41, 'ET2', TableShape::Square, 4, 190, 70, 80, 80, '#6B4E9B'],
                    [42, 'ET3', TableShape::Round, 10, 330, 55, 140, 140, '#4B3670'],
                    [43, 'ET4', TableShape::Square, 4, 520, 70, 80, 80, '#6B4E9B'],
                ],
            ],
        ];

        /** @var array<string, int> $tableIds */
        $tableIds = [];

        foreach ($floors as $floorName => $floor) {
            $floorId = (int) DB::table('restaurant_floors')->insertGetId([
                'uuid' => Demo::uuid('floor:'.Demo::slug($floorName)),
                'company_id' => $companyId,
                'name' => $floorName,
                'background_color' => $floor['color'],
                'sequence' => $floor['sequence'],
                'table_count' => count($floor['tables']),
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $payload = [];
            foreach ($floor['tables'] as [$number, $name, $shape, $seats, $x, $y, $width, $height, $color]) {
                $payload[] = [
                    'uuid' => Demo::uuid('table:'.$name),
                    'restaurant_floor_id' => $floorId,
                    'company_id' => $companyId,
                    'table_number' => $number,
                    'name' => $name,
                    'identifier' => strtoupper(Demo::token('table:'.$name, 8)),
                    'shape' => $shape->value,
                    'position_x' => number_format($x, 2, '.', ''),
                    'position_y' => number_format($y, 2, '.', ''),
                    'width' => number_format($width, 2, '.', ''),
                    'height' => number_format($height, 2, '.', ''),
                    'seats' => $seats,
                    'color' => $color,
                    'parent_id' => null,
                    'active' => true,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
            DB::table('restaurant_tables')->insert($payload);

            foreach (DB::table('restaurant_tables')->where('restaurant_floor_id', $floorId)->get() as $table) {
                $tableIds[(string) $table->name] = (int) $table->id;
            }

            $this->linkFloorToConfigs($floorName, $floorId, $companyId);
        }

        // One physically linked pair: T4 snaps onto T3 for a party of eight.
        DB::table('restaurant_tables')->where('id', $tableIds['T4'])->update([
            'parent_id' => $tableIds['T3'],
            'updated_at' => $now,
        ]);
    }

    private function linkFloorToConfigs(string $floorName, int $floorId, int $companyId): void
    {
        $configNames = match ($floorName) {
            self::FLOOR_TERRACE => [PosConfigSeeder::CONFIG_ROOM, PosConfigSeeder::CONFIG_BAR],
            default => [PosConfigSeeder::CONFIG_ROOM],
        };

        $configIds = DB::table('pos_configs')
            ->where('company_id', $companyId)
            ->whereIn('name', $configNames)
            ->pluck('id');

        foreach ($configIds as $configId) {
            DB::table('pos_config_floor')->insert([
                'pos_config_id' => $configId,
                'restaurant_floor_id' => $floorId,
            ]);
        }
    }
}
