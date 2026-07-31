<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\CashRoundingMethod;
use App\Enums\SymbolPosition;
use App\Enums\UomType;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Reference data that is not owned by any one company: currencies, countries,
 * languages, decimal precisions and the unit-of-measure tree.
 *
 * `cash_roundings` ARE company-scoped, so they are seeded here for every company
 * that already exists (and re-seeded by {@see CompanySeeder} right after it
 * creates the demo company) — that way `--class=BaseDataSeeder` works on both a
 * virgin and an already-populated database.
 */
class BaseDataSeeder extends Seeder
{
    public function run(): void
    {
        Demo::reseed('base');

        $now = Demo::ts(Demo::clock());

        $this->seedCurrencies($now);
        $this->seedCountries($now);
        $this->seedLanguages($now);
        $this->seedDecimalPrecisions($now);
        $this->seedUoms($now);

        foreach (DB::table('companies')->pluck('id') as $companyId) {
            $this->seedCashRoundings((int) $companyId);
        }
    }

    private function seedCurrencies(string $now): void
    {
        if (DB::table('currencies')->exists()) {
            return;
        }

        DB::table('currencies')->insert([
            [
                'code' => 'EUR', 'name' => 'Euro', 'symbol' => '€',
                'symbol_position' => SymbolPosition::After->value,
                'decimal_places' => 2, 'rounding' => '0.010000', 'iso_numeric' => 978,
                'active' => true, 'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'code' => 'MAD', 'name' => 'Dirham marocain', 'symbol' => 'DH',
                'symbol_position' => SymbolPosition::After->value,
                'decimal_places' => 2, 'rounding' => '0.010000', 'iso_numeric' => 504,
                'active' => true, 'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'code' => 'USD', 'name' => 'US Dollar', 'symbol' => '$',
                'symbol_position' => SymbolPosition::Before->value,
                'decimal_places' => 2, 'rounding' => '0.010000', 'iso_numeric' => 840,
                'active' => true, 'created_at' => $now, 'updated_at' => $now,
            ],
        ]);
    }

    private function seedCountries(string $now): void
    {
        if (DB::table('countries')->exists()) {
            return;
        }

        $currencies = DB::table('currencies')->pluck('id', 'code');

        /** @var list<array{0:string,1:string,2:int,3:?string,4:?string,5:bool}> $rows */
        $rows = [
            ['France', 'FR', 33, 'TVA', 'EUR', false],
            ['Maroc', 'MA', 212, 'ICE', 'MAD', false],
            ['Belgique', 'BE', 32, 'BTW/TVA', 'EUR', false],
            ['Espagne', 'ES', 34, 'NIF', 'EUR', false],
            ['Allemagne', 'DE', 49, 'USt-IdNr.', 'EUR', false],
            ['Italie', 'IT', 39, 'P.IVA', 'EUR', false],
            ['Portugal', 'PT', 351, 'NIF', 'EUR', false],
            ['Pays-Bas', 'NL', 31, 'BTW', 'EUR', false],
            ['Luxembourg', 'LU', 352, 'TVA', 'EUR', false],
            ['Suisse', 'CH', 41, 'IDE/TVA', null, false],
            ['Royaume-Uni', 'GB', 44, 'VAT', null, false],
            ['Irlande', 'IE', 353, 'VAT', 'EUR', false],
            ['Tunisie', 'TN', 216, 'MF', null, false],
            ['Algérie', 'DZ', 213, 'NIF', null, false],
            ['Sénégal', 'SN', 221, 'NINEA', null, false],
            ['Canada', 'CA', 1, 'GST/HST', null, true],
            ['États-Unis', 'US', 1, 'EIN', 'USD', true],
        ];

        $payload = [];
        foreach ($rows as [$name, $code, $phone, $vatLabel, $currencyCode, $requiresState]) {
            $payload[] = [
                'name' => $name,
                'code' => $code,
                'phone_code' => $phone,
                'vat_label' => $vatLabel,
                'currency_id' => $currencyCode === null ? null : $currencies[$currencyCode],
                'requires_state' => $requiresState,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        DB::table('countries')->insert($payload);

        $this->seedStates($now);
    }

    private function seedStates(string $now): void
    {
        $countries = DB::table('countries')->pluck('id', 'code');

        /** @var array<string, array<string, string>> $states */
        $states = [
            'FR' => [
                'IDF' => 'Île-de-France',
                'PAC' => "Provence-Alpes-Côte d'Azur",
                'ARA' => 'Auvergne-Rhône-Alpes',
                'OCC' => 'Occitanie',
                'NAQ' => 'Nouvelle-Aquitaine',
                'BRE' => 'Bretagne',
            ],
            'MA' => [
                'CAS' => 'Casablanca-Settat',
                'RSK' => 'Rabat-Salé-Kénitra',
                'MAR' => 'Marrakech-Safi',
                'TAN' => 'Tanger-Tétouan-Al Hoceïma',
                'FES' => 'Fès-Meknès',
            ],
            'US' => [
                'NY' => 'New York',
                'CA' => 'California',
                'TX' => 'Texas',
                'FL' => 'Florida',
            ],
            'CA' => [
                'QC' => 'Québec',
                'ON' => 'Ontario',
            ],
        ];

        $payload = [];
        foreach ($states as $countryCode => $list) {
            foreach ($list as $code => $name) {
                $payload[] = [
                    'country_id' => $countries[$countryCode],
                    'name' => $name,
                    'code' => $code,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
        }
        DB::table('country_states')->insert($payload);
    }

    private function seedLanguages(string $now): void
    {
        if (DB::table('languages')->exists()) {
            return;
        }

        DB::table('languages')->insert([
            [
                'code' => 'fr_FR', 'iso_code' => 'fr', 'name' => 'Français',
                'flag_url' => '/flags/fr.svg', 'is_rtl' => false, 'active' => true,
                'sequence' => 1, 'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'code' => 'en_US', 'iso_code' => 'en', 'name' => 'English (US)',
                'flag_url' => '/flags/us.svg', 'is_rtl' => false, 'active' => true,
                'sequence' => 2, 'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'code' => 'ar_MA', 'iso_code' => 'ar', 'name' => 'العربية (المغرب)',
                'flag_url' => '/flags/ma.svg', 'is_rtl' => true, 'active' => true,
                'sequence' => 3, 'created_at' => $now, 'updated_at' => $now,
            ],
        ]);
    }

    private function seedDecimalPrecisions(string $now): void
    {
        if (DB::table('decimal_precisions')->exists()) {
            return;
        }

        $rows = [
            'Product Price' => 4,
            'Product Unit of Measure' => 3,
            'Discount' => 2,
            'Product Uom Categ' => 3,
            'Account' => 2,
            'Payment Terms' => 6,
            'Stock Weight' => 3,
            'Loyalty Points' => 3,
        ];

        $payload = [];
        foreach ($rows as $name => $digits) {
            $payload[] = ['name' => $name, 'digits' => $digits, 'created_at' => $now, 'updated_at' => $now];
        }
        DB::table('decimal_precisions')->insert($payload);
    }

    /**
     * `factor` follows Odoo semantics: the ratio to the category's reference unit.
     * Smaller units have a factor > 1 (1 kg = 1000 g), bigger units < 1 (1 dozen = 12 units).
     */
    private function seedUoms(string $now): void
    {
        if (DB::table('uom_categories')->exists()) {
            return;
        }

        /** @var array<string, list<array{0:string,1:UomType,2:string,3:string,4:bool}>> $tree */
        $tree = [
            'Unité' => [
                ['Unité(s)', UomType::Reference, '1.000000000000', '1.000000', true],
                ['Douzaine', UomType::Bigger, '0.083333333333', '1.000000', true],
                ['Pack de 6', UomType::Bigger, '0.166666666667', '1.000000', true],
                ['Carton de 24', UomType::Bigger, '0.041666666667', '1.000000', true],
            ],
            'Poids' => [
                ['kg', UomType::Reference, '1.000000000000', '0.001000', false],
                ['g', UomType::Smaller, '1000.000000000000', '1.000000', false],
                ['Portion 150 g', UomType::Smaller, '6.666666666667', '1.000000', true],
            ],
            'Volume' => [
                ['L', UomType::Reference, '1.000000000000', '0.001000', false],
                ['cL', UomType::Smaller, '100.000000000000', '1.000000', false],
                ['mL', UomType::Smaller, '1000.000000000000', '1.000000', false],
            ],
            'Durée' => [
                ['Heure', UomType::Reference, '1.000000000000', '0.010000', true],
                ['Minute', UomType::Smaller, '60.000000000000', '1.000000', true],
            ],
        ];

        foreach ($tree as $categoryName => $units) {
            $categoryId = (int) DB::table('uom_categories')->insertGetId([
                'name' => $categoryName, 'created_at' => $now, 'updated_at' => $now,
            ]);

            $payload = [];
            foreach ($units as [$name, $type, $factor, $rounding, $groupable]) {
                $payload[] = [
                    'uom_category_id' => $categoryId,
                    'name' => $name,
                    'uom_type' => $type->value,
                    'factor' => $factor,
                    'rounding' => $rounding,
                    'is_pos_groupable' => $groupable,
                    'active' => true,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
            DB::table('uoms')->insert($payload);
        }
    }

    /**
     * Cash roundings are company-scoped; called both from {@see run()} (for
     * companies that already exist) and from {@see CompanySeeder}.
     */
    public function seedCashRoundings(int $companyId): void
    {
        if (DB::table('cash_roundings')->where('company_id', $companyId)->exists()) {
            return;
        }

        $now = Demo::ts(Demo::clock());

        DB::table('cash_roundings')->insert([
            [
                'company_id' => $companyId,
                'name' => 'Arrondi 5 centimes (espèces)',
                'rounding' => '0.050000',
                'rounding_method' => CashRoundingMethod::HalfUp->value,
                'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'company_id' => $companyId,
                'name' => 'Arrondi 10 centimes',
                'rounding' => '0.100000',
                'rounding_method' => CashRoundingMethod::HalfUp->value,
                'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'company_id' => $companyId,
                'name' => 'Arrondi à l’euro supérieur',
                'rounding' => '1.000000',
                'rounding_method' => CashRoundingMethod::Up->value,
                'created_at' => $now, 'updated_at' => $now,
            ],
        ]);
    }
}
