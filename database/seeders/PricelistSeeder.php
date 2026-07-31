<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\PricelistAppliedOn;
use App\Enums\PricelistBase;
use App\Enums\PricelistComputePrice;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Three pricelists that between them use every `compute_price` mode.
 *
 *  - "Tarif public"  — the menu price, one global `fixed`-free pass-through rule;
 *  - "Happy Hour"    — −30 % on Bières and Cocktails, 17:00→19:00, one dated item
 *                      pair per day for the coming week (the schema dates windows
 *                      with `date_start` / `date_end`, there is no weekly rule);
 *  - "Terrasse"      — a `formula` rule: +8 % on everything, rounded to 0,10 €,
 *                      with a floor margin, plus one product-level override.
 */
class PricelistSeeder extends Seeder
{
    public const PUBLIC = 'Tarif public';

    public const HAPPY_HOUR = 'Happy Hour (17h–19h)';

    public const TERRACE = 'Terrasse';

    /** Number of days of Happy Hour windows generated forward from the demo clock. */
    private const HAPPY_HOUR_DAYS = 7;

    public function run(): void
    {
        Demo::reseed('pricelists');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0 || DB::table('pricelists')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());
        $currencyId = (int) DB::table('currencies')->where('code', 'EUR')->value('id');

        $publicId = $this->createPricelist($companyId, $currencyId, self::PUBLIC, 1, $now);
        $happyId = $this->createPricelist($companyId, $currencyId, self::HAPPY_HOUR, 2, $now);
        $terraceId = $this->createPricelist($companyId, $currencyId, self::TERRACE, 3, $now);

        $this->seedPublicItems($publicId, $companyId, $now);
        $this->seedHappyHourItems($happyId, $companyId, $now);
        $this->seedTerraceItems($terraceId, $publicId, $companyId, $now);
    }

    private function createPricelist(int $companyId, int $currencyId, string $name, int $sequence, string $now): int
    {
        return (int) DB::table('pricelists')->insertGetId([
            'company_id' => $companyId,
            'currency_id' => $currencyId,
            'name' => $name,
            'sequence' => $sequence,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    /** The public tariff is the catalog price: a single no-op global rule. */
    private function seedPublicItems(int $pricelistId, int $companyId, string $now): void
    {
        DB::table('pricelist_items')->insert([
            'pricelist_id' => $pricelistId,
            'company_id' => $companyId,
            'applied_on' => PricelistAppliedOn::Global->value,
            'min_quantity' => '0.000',
            'compute_price' => PricelistComputePrice::Percentage->value,
            'percent_price' => '0.0000',
            'base' => PricelistBase::ListPrice->value,
            'sequence' => 100,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    private function seedHappyHourItems(int $pricelistId, int $companyId, string $now): void
    {
        $categories = DB::table('pos_categories')
            ->where('company_id', $companyId)
            ->whereIn('name', ['Bières', 'Cocktails'])
            ->pluck('id', 'name');

        $payload = [];
        for ($offset = 0; $offset < self::HAPPY_HOUR_DAYS; $offset++) {
            $start = Demo::at(-$offset, 17, 0);
            $end = Demo::at(-$offset, 19, 0);

            foreach ($categories as $categoryId) {
                $payload[] = [
                    'pricelist_id' => $pricelistId,
                    'company_id' => $companyId,
                    'applied_on' => PricelistAppliedOn::PosCategory->value,
                    'pos_category_id' => $categoryId,
                    'min_quantity' => '0.000',
                    'date_start' => Demo::ts($start),
                    'date_end' => Demo::ts($end),
                    'compute_price' => PricelistComputePrice::Percentage->value,
                    'percent_price' => '30.0000',
                    'base' => PricelistBase::ListPrice->value,
                    'sequence' => 10 + $offset,
                    'active' => true,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
        }

        DB::table('pricelist_items')->insert($payload);

        // Outside the window the Happy Hour list falls back to the menu price.
        DB::table('pricelist_items')->insert([
            'pricelist_id' => $pricelistId,
            'company_id' => $companyId,
            'applied_on' => PricelistAppliedOn::Global->value,
            'min_quantity' => '0.000',
            'compute_price' => PricelistComputePrice::Percentage->value,
            'percent_price' => '0.0000',
            'base' => PricelistBase::ListPrice->value,
            'sequence' => 500,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }

    private function seedTerraceItems(int $pricelistId, int $publicId, int $companyId, string $now): void
    {
        $pichetId = DB::table('products')
            ->where('company_id', $companyId)
            ->where('name', 'Côtes du Rhône — bouteille 75 cl')
            ->value('id');

        $cafeId = DB::table('products')
            ->where('company_id', $companyId)
            ->where('name', 'Café expresso')
            ->value('id');

        $payload = [
            // price = list_price × (1 − (−8)/100) rounded to 0,10 €, margin-floored.
            [
                'pricelist_id' => $pricelistId,
                'company_id' => $companyId,
                'applied_on' => PricelistAppliedOn::Global->value,
                'min_quantity' => '0.000',
                'compute_price' => PricelistComputePrice::Formula->value,
                'base' => PricelistBase::ListPrice->value,
                'price_discount' => '-8.0000',
                'price_surcharge' => '0.0000',
                'price_round' => '0.100000',
                'price_min_margin' => '0.5000',
                'price_max_margin' => '5.0000',
                'sequence' => 100,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            // Coffee keeps a flat terrace price whatever the formula says.
            [
                'pricelist_id' => $pricelistId,
                'company_id' => $companyId,
                'applied_on' => PricelistAppliedOn::Product->value,
                'product_id' => $cafeId,
                'min_quantity' => '0.000',
                'compute_price' => PricelistComputePrice::Fixed->value,
                'fixed_price' => '2.8000',
                'base' => PricelistBase::ListPrice->value,
                'sequence' => 10,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ],
            // A bottle bought by the case is derived from the public list, −5 %.
            [
                'pricelist_id' => $pricelistId,
                'company_id' => $companyId,
                'applied_on' => PricelistAppliedOn::Product->value,
                'product_id' => $pichetId,
                'min_quantity' => '6.000',
                'compute_price' => PricelistComputePrice::Formula->value,
                'base' => PricelistBase::Pricelist->value,
                'base_pricelist_id' => $publicId,
                'price_discount' => '5.0000',
                'price_round' => '0.050000',
                'sequence' => 20,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ],
        ];

        // Each rule uses a different subset of the formula columns, so they are
        // inserted one by one rather than as one multi-row VALUES list.
        foreach ($payload as $item) {
            DB::table('pricelist_items')->insert($item);
        }
    }
}
