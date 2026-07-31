<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\PrepDisplayLayout;
use App\Enums\PrepStageType;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Two preparation displays with the classic four-column board.
 *
 * Routing is by register category: the hot kitchen sees food, the bar sees
 * drinks, and nothing is shown on both boards — that is what makes the demo
 * legible when an order carries a steak and a beer.
 *
 * Query builder only: the `App\Models\Kitchen\*` models belong to another
 * workstream.
 */
class KitchenSeeder extends Seeder
{
    public const DISPLAY_KITCHEN = 'Cuisine chaude';

    public const DISPLAY_BAR = 'Bar';

    public function run(): void
    {
        Demo::reseed('kitchen');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0 || DB::table('prep_displays')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());
        $categories = DB::table('pos_categories')->where('company_id', $companyId)->pluck('id', 'name');

        /** @var array<string, array{layout: PrepDisplayLayout, average: int, late: int, categories: list<string>, configs: list<string>}> $displays */
        $displays = [
            self::DISPLAY_KITCHEN => [
                'layout' => PrepDisplayLayout::Columns,
                'average' => 14,
                'late' => 20,
                'categories' => ['Entrées', 'Plats', 'Tajines', 'Pizzas', 'Burgers', 'Desserts', 'Menus'],
                'configs' => [PosConfigSeeder::CONFIG_ROOM, PosConfigSeeder::CONFIG_COUNTER],
            ],
            self::DISPLAY_BAR => [
                'layout' => PrepDisplayLayout::Grid,
                'average' => 4,
                'late' => 8,
                'categories' => ['Boissons chaudes', 'Boissons fraîches', 'Bières', 'Vins', 'Cocktails'],
                'configs' => [PosConfigSeeder::CONFIG_ROOM, PosConfigSeeder::CONFIG_BAR],
            ],
        ];

        /** @var list<array{0:string,1:PrepStageType,2:string,3:?int,4:bool}> $stages */
        $stages = [
            ['À faire', PrepStageType::Todo, '#B23A48', 6, true],
            ['En cours', PrepStageType::InProgress, '#D9A404', 12, false],
            ['Prêt', PrepStageType::Ready, '#5B7553', 5, false],
            ['Servi', PrepStageType::Done, '#8A8A8A', null, false],
        ];

        foreach ($displays as $name => $display) {
            $displayId = (int) DB::table('prep_displays')->insertGetId([
                'uuid' => Demo::uuid('prep-display:'.Demo::slug($name)),
                'company_id' => $companyId,
                'name' => $name,
                'access_token' => Demo::token('prep-display:'.Demo::slug($name), 32),
                'layout' => $display['layout']->value,
                'auto_advance_on_all_ready' => true,
                'show_all_categories' => false,
                'average_prep_minutes' => $display['average'],
                'late_threshold_minutes' => $display['late'],
                'done_retention_minutes' => 60,
                'sound_on_new_order' => true,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $sequence = 10;
            foreach ($stages as [$stageName, $type, $color, $alert, $isDefault]) {
                DB::table('prep_stages')->insert([
                    'prep_display_id' => $displayId,
                    'name' => $stageName,
                    'stage_type' => $type->value,
                    'color' => $color,
                    'alert_after_minutes' => $alert,
                    'sequence' => $sequence,
                    'is_default' => $isDefault,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                $sequence += 10;
            }

            foreach ($display['categories'] as $categoryName) {
                DB::table('pos_category_prep_display')->insert([
                    'prep_display_id' => $displayId,
                    'pos_category_id' => $categories[$categoryName],
                ]);
            }

            $configIds = DB::table('pos_configs')
                ->where('company_id', $companyId)
                ->whereIn('name', $display['configs'])
                ->pluck('id');

            foreach ($configIds as $configId) {
                DB::table('pos_config_prep_display')->insert([
                    'pos_config_id' => $configId,
                    'prep_display_id' => $displayId,
                ]);
            }
        }
    }
}
