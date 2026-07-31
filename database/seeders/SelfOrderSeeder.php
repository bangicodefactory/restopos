<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\DeviceType;
use App\Enums\SelfOrderLinkStyle;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\SettingValueType;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Turns "Salle" into a QR self-order point of sale and adds a kiosk register.
 *
 *  - "Salle" runs in `mobile` mode, served at the table, paid after each order;
 *  - a fourth config, "Borne libre-service", runs in `kiosk` mode at the counter;
 *  - the per-table capability tokens are the `restaurant_tables.identifier`
 *    values seeded by {@see RestaurantSeeder}; they are mirrored into a setting
 *    so the demo can print the QR sheet without a join.
 *
 * Query builder only: the `App\Models\SelfOrder\*` models belong to another
 * workstream.
 */
class SelfOrderSeeder extends Seeder
{
    public const CONFIG_KIOSK = 'Borne libre-service';

    public function run(): void
    {
        Demo::reseed('selforder');

        $companyId = (int) DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === 0) {
            return;
        }

        $now = Demo::ts(Demo::clock());

        $this->enableMobileSelfOrder($companyId, $now);
        $kioskId = $this->createKioskConfig($companyId, $now);
        $this->seedCustomLinks($companyId, $now, $kioskId);
        $this->seedTableTokenSetting($companyId, $now);
    }

    private function enableMobileSelfOrder(int $companyId, string $now): void
    {
        $frenchId = DB::table('languages')->where('code', 'fr_FR')->value('id');
        $adminId = DB::table('users')->where('email', EmployeeSeeder::ADMIN_EMAIL)->value('id');

        DB::table('pos_configs')
            ->where('company_id', $companyId)
            ->where('name', PosConfigSeeder::CONFIG_ROOM)
            ->update([
                'self_ordering_mode' => SelfOrderMode::Mobile->value,
                'self_ordering_service_mode' => SelfOrderServiceMode::Table->value,
                'self_ordering_pay_after' => SelfOrderPayAfter::Meal->value,
                'self_ordering_default_language_id' => $frenchId,
                'self_ordering_default_user_id' => $adminId,
                'self_ordering_brand_name' => Demo::COMPANY_NAME,
                'self_ordering_primary_color' => '#8C1C13',
                'self_ordering_text_color' => '#FFF8F0',
                'config_revision' => 2,
                'last_config_change_at' => Demo::ms(Demo::clock()),
                'updated_at' => $now,
            ]);

        // The counter register accepts consultation-only QR menus.
        DB::table('pos_configs')
            ->where('company_id', $companyId)
            ->where('name', PosConfigSeeder::CONFIG_COUNTER)
            ->update([
                'self_ordering_mode' => SelfOrderMode::Consultation->value,
                'self_ordering_default_language_id' => $frenchId,
                'updated_at' => $now,
            ]);
    }

    private function createKioskConfig(int $companyId, string $now): int
    {
        $existing = DB::table('pos_configs')
            ->where('company_id', $companyId)->where('name', self::CONFIG_KIOSK)->value('id');
        if ($existing !== null) {
            return (int) $existing;
        }

        $room = DB::table('pos_configs')
            ->where('company_id', $companyId)
            ->where('name', PosConfigSeeder::CONFIG_COUNTER)
            ->first();

        if ($room === null) {
            return 0;
        }

        /** @var array<string, mixed> $attributes */
        $attributes = (array) $room;
        unset($attributes['id'], $attributes['deleted_at']);

        $attributes['uuid'] = Demo::uuid('config:borne');
        $attributes['name'] = self::CONFIG_KIOSK;
        $attributes['access_token'] = Demo::token('config:borne', 32);
        $attributes['is_restaurant'] = false;
        $attributes['self_ordering_mode'] = SelfOrderMode::Kiosk->value;
        $attributes['self_ordering_service_mode'] = SelfOrderServiceMode::Counter->value;
        $attributes['self_ordering_pay_after'] = SelfOrderPayAfter::Each->value;
        $attributes['self_ordering_brand_name'] = Demo::COMPANY_NAME;
        $attributes['kiosk_idle_seconds'] = 60;
        $attributes['kiosk_confirmation_seconds'] = 20;
        $attributes['auto_print_receipt'] = true;
        $attributes['skip_receipt_screen'] = false;
        $attributes['use_employee_login'] = false;
        $attributes['has_cash_control'] = false;
        $attributes['enable_tips'] = false;
        $attributes['tip_product_id'] = null;
        $attributes['created_at'] = $now;
        $attributes['updated_at'] = $now;

        $kioskId = (int) DB::table('pos_configs')->insertGetId($attributes);

        // Copy the counter's relations, minus cash and account payment methods.
        $onlineMethodId = DB::table('payment_methods')
            ->where('company_id', $companyId)
            ->where('name', PosConfigSeeder::PM_ONLINE)->value('id');
        $cardMethodId = DB::table('payment_methods')
            ->where('company_id', $companyId)
            ->where('name', PosConfigSeeder::PM_CARD)->value('id');

        DB::table('pos_config_payment_method')->insert([
            ['pos_config_id' => $kioskId, 'payment_method_id' => $cardMethodId, 'sequence' => 10, 'is_fast_payment' => true],
            ['pos_config_id' => $kioskId, 'payment_method_id' => $onlineMethodId, 'sequence' => 20, 'is_fast_payment' => false],
        ]);

        foreach (['pos_config_pricelist', 'pos_config_fiscal_position', 'pos_config_preset', 'pos_config_printer', 'pos_config_note', 'pos_config_pos_category', 'pos_config_language', 'pos_config_prep_display'] as $pivot) {
            $rows = DB::table($pivot)->where('pos_config_id', $room->id)->get();
            $payload = [];
            foreach ($rows as $pivotRow) {
                $copy = (array) $pivotRow;
                $copy['pos_config_id'] = $kioskId;
                $payload[] = $copy;
            }
            if ($payload !== []) {
                DB::table($pivot)->insert($payload);
            }
        }

        DB::table('pos_devices')->insert([
            'uuid' => Demo::uuid('device:borne:1'),
            'pos_config_id' => $kioskId,
            'device_identifier' => 1,
            'name' => 'Borne d’entrée',
            'device_type' => DeviceType::Kiosk->value,
            'user_agent' => 'Mozilla/5.0 (X11; Linux aarch64) RestoPOS-Kiosk/1.0',
            'last_seen_at' => $now,
            'last_synced_at' => Demo::ms(Demo::clock()),
            'has_paper' => true,
            'active' => true,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        foreach (['order', 'receipt', 'session', 'refund'] as $purpose) {
            DB::table('sequences')->insert([
                'company_id' => $companyId,
                'pos_config_id' => $kioskId,
                'purpose' => $purpose,
                'period_key' => null,
                'prefix' => 'BOR/'.strtoupper(substr($purpose, 0, 1)),
                'padding' => 5,
                'next_value' => 1,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }

        return $kioskId;
    }

    private function seedCustomLinks(int $companyId, string $now, int $kioskId): void
    {
        if (DB::table('self_order_custom_links')->where('company_id', $companyId)->exists()) {
            return;
        }

        /** @var list<array{0:string,1:string,2:SelfOrderLinkStyle,3:bool,4:bool}> $links */
        $links = [
            ['Notre carte des vins', 'https://bistronumerique.fr/carte-des-vins', SelfOrderLinkStyle::Primary, true, true],
            ['Réserver une table', 'https://bistronumerique.fr/reservation', SelfOrderLinkStyle::Secondary, true, false],
            ['Allergènes & informations', 'https://bistronumerique.fr/allergenes', SelfOrderLinkStyle::Info, false, true],
            ['Nous suivre sur Instagram', 'https://instagram.com/bistronumerique', SelfOrderLinkStyle::Dark, true, true],
            ['Offres de la semaine', 'https://bistronumerique.fr/offres', SelfOrderLinkStyle::Warning, false, false],
        ];

        foreach ($links as $index => [$name, $url, $style, $newTab, $onKiosk]) {
            $linkId = (int) DB::table('self_order_custom_links')->insertGetId([
                'company_id' => $companyId,
                'name' => $name,
                'url' => $url,
                'style' => $style->value,
                'open_in_new_tab' => $newTab,
                'sequence' => ($index + 1) * 10,
                'active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            // No pivot row ⇒ the link shows on every config; pin two to the kiosk only.
            if ($onKiosk && $kioskId > 0 && $index >= 3) {
                DB::table('pos_config_self_order_custom_link')->insert([
                    'pos_config_id' => $kioskId,
                    'self_order_custom_link_id' => $linkId,
                ]);
            }
        }
    }

    /** Mirror the per-table QR capability tokens into a setting for the print sheet. */
    private function seedTableTokenSetting(int $companyId, string $now): void
    {
        $exists = DB::table('settings')
            ->where('company_id', $companyId)
            ->where('key', 'selforder.table_tokens')
            ->exists();
        if ($exists) {
            return;
        }

        $tokens = DB::table('restaurant_tables')
            ->where('company_id', $companyId)
            ->orderBy('table_number')
            ->pluck('identifier', 'name')
            ->all();

        DB::table('settings')->insert([
            'company_id' => $companyId,
            'key' => 'selforder.table_tokens',
            'value' => json_encode($tokens, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
            'value_type' => SettingValueType::Json->value,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
    }
}
