<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\AddressType;
use App\Enums\ReceiptTicketUrlDisplayMode;
use App\Enums\SettingValueType;
use App\Enums\TaxRoundingMethod;
use App\Support\Tax\TaxEngine;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * The demo tenant: "Le Bistro Numérique", a French-Moroccan bistro in Paris 18e.
 *
 * Prices are tax-inclusive (French retail convention) and taxes round per line,
 * which is what {@see TaxEngine} is driven with everywhere else
 * in the demo data.
 */
class CompanySeeder extends Seeder
{
    public function run(): void
    {
        $rng = Demo::reseed('company');
        $now = Demo::ts(Demo::clock());

        $existing = DB::table('companies')->where('name', Demo::COMPANY_NAME)->first();
        if ($existing !== null) {
            $this->seedCustomers((int) $existing->id, $now, $rng);

            return;
        }

        $currencyId = (int) DB::table('currencies')->where('code', 'EUR')->value('id');
        $countryId = (int) DB::table('countries')->where('code', 'FR')->value('id');
        $stateId = DB::table('country_states')
            ->where('country_id', $countryId)->where('code', 'IDF')->value('id');

        $companyId = (int) DB::table('companies')->insertGetId([
            'name' => Demo::COMPANY_NAME,
            'legal_name' => 'SARL LE BISTRO NUMERIQUE',
            'currency_id' => $currencyId,
            'country_id' => $countryId,
            'state_id' => $stateId,
            'vat' => 'FR40123456824',
            'company_registry' => '843 271 905 R.C.S. Paris',
            'street' => '12 rue des Abbesses',
            'street2' => 'Rez-de-chaussée',
            'city' => 'Paris',
            'zip' => '75018',
            'phone' => '+33 1 42 55 08 17',
            'email' => 'bonjour@bistronumerique.fr',
            'website' => 'https://bistronumerique.fr',
            'timezone' => 'Europe/Paris',
            // Prices on the menu include VAT and every line is rounded on its own.
            'tax_calculation_rounding_method' => TaxRoundingMethod::RoundPerLine->value,
            'price_include_default' => true,
            'receipt_use_ticket_qr' => true,
            'receipt_ticket_unique_code' => true,
            'receipt_ticket_url_display_mode' => ReceiptTicketUrlDisplayMode::QrCodeAndUrl->value,
            'stale_session_alert_days' => 3,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        // Company-scoped reference data that BaseDataSeeder owns.
        (new BaseDataSeeder)->seedCashRoundings($companyId);

        $this->seedCurrencyRates($companyId, $now);
        $this->seedSettings($companyId, $now);
        $this->seedCustomers($companyId, $now, $rng);

        DB::table('companies')->where('id', $companyId)->update([
            'default_customer_id' => DB::table('customers')
                ->where('company_id', $companyId)
                ->where('name', 'Client comptoir')
                ->value('id'),
        ]);
    }

    private function seedCurrencyRates(int $companyId, string $now): void
    {
        $currencies = DB::table('currencies')->pluck('id', 'code');
        $rateDate = Demo::day(0)->format('Y-m-d');

        DB::table('currency_rates')->insert([
            [
                'currency_id' => $currencies['EUR'], 'company_id' => $companyId,
                'rate_date' => $rateDate, 'rate' => '1.000000000000',
                'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'currency_id' => $currencies['MAD'], 'company_id' => $companyId,
                'rate_date' => $rateDate, 'rate' => '10.850000000000',
                'created_at' => $now, 'updated_at' => $now,
            ],
            [
                'currency_id' => $currencies['USD'], 'company_id' => $companyId,
                'rate_date' => $rateDate, 'rate' => '1.083000000000',
                'created_at' => $now, 'updated_at' => $now,
            ],
        ]);
    }

    private function seedSettings(int $companyId, string $now): void
    {
        /** @var array<string, array{0:string,1:SettingValueType}> $settings */
        $settings = [
            'pos.receipt_footer' => ['Merci de votre visite — à bientôt au Bistro Numérique !', SettingValueType::String],
            'pos.default_guest_count' => ['2', SettingValueType::Int],
            'pos.service_charge_percent' => ['0', SettingValueType::Float],
            'pos.allow_negative_stock' => ['1', SettingValueType::Bool],
            'restaurant.auto_release_table_minutes' => ['20', SettingValueType::Int],
            'kitchen.late_order_alert_minutes' => ['12', SettingValueType::Int],
            'selforder.terms_url' => ['https://bistronumerique.fr/cgv', SettingValueType::String],
            'company.opening_hours' => [
                json_encode([
                    'mon' => ['12:00-14:30', '19:00-23:00'],
                    'tue' => ['12:00-14:30', '19:00-23:00'],
                    'wed' => ['12:00-14:30', '19:00-23:00'],
                    'thu' => ['12:00-14:30', '19:00-23:30'],
                    'fri' => ['12:00-14:30', '19:00-00:30'],
                    'sat' => ['12:00-15:00', '19:00-00:30'],
                    'sun' => ['12:00-15:00'],
                ], JSON_THROW_ON_ERROR),
                SettingValueType::Json,
            ],
        ];

        $payload = [];
        foreach ($settings as $key => [$value, $type]) {
            $payload[] = [
                'company_id' => $companyId,
                'key' => $key,
                'value' => $value,
                'value_type' => $type->value,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        DB::table('settings')->insert($payload);
    }

    private function seedCustomers(int $companyId, string $now, Demo $rng): void
    {
        if (DB::table('customers')->where('company_id', $companyId)->exists()) {
            return;
        }

        $countries = DB::table('countries')->pluck('id', 'code');

        /** @var list<array{0:string,1:?string,2:?string,3:bool,4:?string,5:?string,6:string}> $people */
        $people = [
            ['Client comptoir', null, null, false, null, null, 'FR'],
            ['Camille Fontaine', 'camille.fontaine@example.fr', '+33 6 12 44 90 21', false, '8 rue Lepic', '75018', 'FR'],
            ['Hugo Marchand', 'hugo.marchand@example.fr', '+33 6 77 21 03 55', false, '21 avenue Junot', '75018', 'FR'],
            ['Nadia Ouazzani', 'nadia.ouazzani@example.ma', '+212 6 61 09 44 12', false, '4 rue de Clignancourt', '75018', 'FR'],
            ['Théo Bertrand', 'theo.bertrand@example.fr', '+33 7 58 12 66 04', false, '33 rue Caulaincourt', '75018', 'FR'],
            ['Julie Ngo', 'julie.ngo@example.fr', '+33 6 03 88 71 42', false, '9 rue Tholozé', '75018', 'FR'],
            ['Rachid Belkacem', 'rachid.belkacem@example.fr', '+33 6 45 30 12 78', false, '17 rue Custine', '75018', 'FR'],
            ['Élodie Vasseur', 'elodie.vasseur@example.fr', '+33 6 91 55 27 30', false, '2 place des Abbesses', '75018', 'FR'],
            ['Marco Rinaldi', 'marco.rinaldi@example.it', '+39 340 118 22 77', false, 'Via Roma 14', '20121', 'IT'],
            ['Sarah Klein', 'sarah.klein@example.de', '+49 151 2233 4455', false, 'Kastanienallee 9', '10435', 'DE'],
            ['Studio Pixel SAS', 'compta@studiopixel.fr', '+33 1 84 20 11 09', true, '5 rue du Faubourg Poissonnière', '75009', 'FR'],
            ['Agence Voltaire SARL', 'facturation@agencevoltaire.fr', '+33 1 43 55 90 12', true, '88 boulevard Voltaire', '75011', 'FR'],
            ['Yasmine Haddad', 'yasmine.haddad@example.fr', '+33 6 22 47 81 09', false, '11 rue Ramey', '75018', 'FR'],
            ['Pierre Lacroix', 'pierre.lacroix@example.fr', '+33 6 14 92 63 55', false, '26 rue Ordener', '75018', 'FR'],
            ['Aïcha Benjelloun', 'aicha.benjelloun@example.ma', '+212 6 22 78 15 40', false, 'Rue Tarik Ibn Ziad 12', '20000', 'MA'],
        ];

        $payload = [];
        foreach ($people as $index => [$name, $email, $phone, $isCompany, $street, $zip, $countryCode]) {
            $payload[] = [
                'uuid' => Demo::uuid('customer:'.$index),
                'company_id' => $companyId,
                'parent_id' => null,
                'address_type' => AddressType::Contact->value,
                'is_company' => $isCompany,
                'name' => $name,
                'display_name' => $name,
                'email' => $email,
                'phone' => $phone,
                'mobile' => $phone,
                'vat' => $isCompany ? 'FR'.(60 + $index).'4'.str_pad((string) (100000 + $index * 7919), 9, '0', STR_PAD_LEFT) : null,
                'street' => $street,
                'city' => $countryCode === 'FR' ? 'Paris' : null,
                'zip' => $zip,
                'country_id' => $countries[$countryCode] ?? null,
                'barcode' => $index === 0 ? null : '042'.str_pad((string) $index, 10, '0', STR_PAD_LEFT),
                'locale' => $countryCode === 'MA' ? 'ar_MA' : 'fr_FR',
                'loyalty_points_cache' => '0.000',
                'order_count' => 0,
                'marketing_opt_in' => $rng->chance(60),
                'note' => $index === 0 ? 'Client anonyme par défaut (ventes au comptoir).' : null,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        DB::table('customers')->insert($payload);
    }
}
