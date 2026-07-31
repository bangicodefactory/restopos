<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\TaxAmountType;
use App\Enums\TaxRoundingStrategy;
use App\Support\Tax\TaxEngine;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * French restaurant VAT, modelled so the demo exercises every branch of
 * {@see TaxEngine}:
 *
 *  - `price_include` — every rate is included in the menu price;
 *  - `sequence`      — the packaging contribution (seq 5) is evaluated before VAT (seq 30);
 *  - `amount_type=fixed` — the €0.05 eco-contribution per unit;
 *  - `amount_type=group` + `tax_children` — "Emballage + TVA 5,5 %" for packaged takeaway;
 *  - fiscal positions — a remap (10 % → 5,5 %) and an exemption (drop every tax).
 *
 * `taxes.description` doubles as a stable code the other seeders look up by.
 */
class TaxSeeder extends Seeder
{
    /** Stable codes stored in `taxes.description`. */
    public const VAT_ON_SITE = 'VAT10';

    public const VAT_ALCOHOL = 'VAT20';

    public const VAT_TAKEAWAY = 'VAT55';

    public const VAT_EXEMPT = 'VAT0';

    public const ECO_CONTRIBUTION = 'ECO005';

    public const TAKEAWAY_PACKAGED = 'PACK55';

    public const FP_TAKEAWAY = 'Vente à emporter';

    public const FP_EXPORT = 'Export / hors taxes';

    public function run(): void
    {
        Demo::reseed('tax');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0 || DB::table('taxes')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());
        $groups = $this->seedGroups($companyId, $now);
        $taxes = $this->seedTaxes($companyId, $now, $groups);
        $this->seedFiscalPositions($companyId, $now, $taxes);
    }

    /** @return array<string, int> group name => id */
    private function seedGroups(int $companyId, string $now): array
    {
        /** @var list<array{0:string,1:string,2:int}> $rows */
        $rows = [
            ['TVA 10 %', 'TVA 10,0%', 10],
            ['TVA 20 %', 'TVA 20,0%', 20],
            ['TVA 5,5 %', 'TVA 5,5%', 30],
            ['Exonéré de TVA', 'Exonéré', 40],
            ['Contributions', 'Éco-contribution', 5],
        ];

        $ids = [];
        foreach ($rows as [$name, $label, $sequence]) {
            $ids[$name] = (int) DB::table('tax_groups')->insertGetId([
                'company_id' => $companyId,
                'name' => $name,
                'receipt_label' => $label,
                'sequence' => $sequence,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }

        return $ids;
    }

    /**
     * @param  array<string, int>  $groups
     * @return array<string, int> tax code => id
     */
    private function seedTaxes(int $companyId, string $now, array $groups): array
    {
        /** @var list<array{code:string,name:string,group:string,type:TaxAmountType,amount:string,sequence:int,priceInclude:bool}> $rows */
        $rows = [
            [
                'code' => self::ECO_CONTRIBUTION,
                'name' => 'Éco-contribution emballage (0,05 €/unité)',
                'group' => 'Contributions',
                'type' => TaxAmountType::Fixed,
                'amount' => '0.0500',
                'sequence' => 5,
                'priceInclude' => true,
            ],
            [
                'code' => self::VAT_ON_SITE,
                'name' => 'TVA 10 % (restauration sur place)',
                'group' => 'TVA 10 %',
                'type' => TaxAmountType::Percent,
                'amount' => '10.0000',
                'sequence' => 10,
                'priceInclude' => true,
            ],
            [
                'code' => self::VAT_ALCOHOL,
                'name' => 'TVA 20 % (boissons alcoolisées)',
                'group' => 'TVA 20 %',
                'type' => TaxAmountType::Percent,
                'amount' => '20.0000',
                'sequence' => 20,
                'priceInclude' => true,
            ],
            [
                'code' => self::VAT_TAKEAWAY,
                'name' => 'TVA 5,5 % (vente à emporter)',
                'group' => 'TVA 5,5 %',
                'type' => TaxAmountType::Percent,
                'amount' => '5.5000',
                'sequence' => 30,
                'priceInclude' => true,
            ],
            [
                'code' => self::VAT_EXEMPT,
                'name' => 'TVA 0 % (exonéré / export)',
                'group' => 'Exonéré de TVA',
                'type' => TaxAmountType::Percent,
                'amount' => '0.0000',
                'sequence' => 40,
                'priceInclude' => true,
            ],
            [
                // Composite: children are resolved and re-sorted by the engine (§6).
                'code' => self::TAKEAWAY_PACKAGED,
                'name' => 'Emballage + TVA 5,5 % (à emporter conditionné)',
                'group' => 'TVA 5,5 %',
                'type' => TaxAmountType::Group,
                'amount' => '0.0000',
                'sequence' => 35,
                'priceInclude' => true,
            ],
        ];

        $ids = [];
        foreach ($rows as $row) {
            $ids[$row['code']] = (int) DB::table('taxes')->insertGetId([
                'company_id' => $companyId,
                'tax_group_id' => $groups[$row['group']],
                'name' => $row['name'],
                'description' => $row['code'],
                'amount_type' => $row['type']->value,
                'amount' => $row['amount'],
                'price_include' => $row['priceInclude'],
                'include_base_amount' => false,
                'is_base_affected' => true,
                'has_negative_factor' => false,
                'sequence' => $row['sequence'],
                'rounding_strategy' => TaxRoundingStrategy::Inherit->value,
                'is_used' => true,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }

        DB::table('tax_children')->insert([
            [
                'parent_tax_id' => $ids[self::TAKEAWAY_PACKAGED],
                'child_tax_id' => $ids[self::ECO_CONTRIBUTION],
                'sequence' => 1,
            ],
            [
                'parent_tax_id' => $ids[self::TAKEAWAY_PACKAGED],
                'child_tax_id' => $ids[self::VAT_TAKEAWAY],
                'sequence' => 2,
            ],
        ]);

        return $ids;
    }

    /** @param  array<string, int>  $taxes */
    private function seedFiscalPositions(int $companyId, string $now, array $taxes): void
    {
        $franceId = (int) DB::table('countries')->where('code', 'FR')->value('id');

        $takeawayId = (int) DB::table('fiscal_positions')->insertGetId([
            'company_id' => $companyId,
            'name' => self::FP_TAKEAWAY,
            'auto_apply' => false,
            'country_id' => $franceId,
            'vat_required' => false,
            'sequence' => 10,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $exportId = (int) DB::table('fiscal_positions')->insertGetId([
            'company_id' => $companyId,
            'name' => self::FP_EXPORT,
            'auto_apply' => true,
            'country_id' => null,
            'vat_required' => true,
            'sequence' => 20,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $mappings = [
            // Takeaway: the reduced 5,5 % rate replaces the 10 % on-site rate.
            ['fiscal_position_id' => $takeawayId, 'tax_src_id' => $taxes[self::VAT_ON_SITE], 'tax_dest_id' => $taxes[self::VAT_TAKEAWAY]],
            // Alcohol stays at 20 % even to go — mapped to itself so the row is explicit.
            ['fiscal_position_id' => $takeawayId, 'tax_src_id' => $taxes[self::VAT_ALCOHOL], 'tax_dest_id' => $taxes[self::VAT_ALCOHOL]],
            // Export: NULL destination drops the tax entirely (§5.2).
            ['fiscal_position_id' => $exportId, 'tax_src_id' => $taxes[self::VAT_ON_SITE], 'tax_dest_id' => null],
            ['fiscal_position_id' => $exportId, 'tax_src_id' => $taxes[self::VAT_ALCOHOL], 'tax_dest_id' => null],
            ['fiscal_position_id' => $exportId, 'tax_src_id' => $taxes[self::VAT_TAKEAWAY], 'tax_dest_id' => null],
            ['fiscal_position_id' => $exportId, 'tax_src_id' => $taxes[self::TAKEAWAY_PACKAGED], 'tax_dest_id' => null],
        ];

        DB::table('fiscal_position_taxes')->insert(array_map(
            static fn (array $row): array => $row + ['created_at' => $now, 'updated_at' => $now],
            $mappings,
        ));
    }
}
