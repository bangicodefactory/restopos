<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\AccessLevel;
use App\Enums\DayPeriod;
use App\Enums\DefaultScreen;
use App\Enums\DenominationType;
use App\Enums\DeviceType;
use App\Enums\NoteScope;
use App\Enums\NotificationChannel;
use App\Enums\NotificationPurpose;
use App\Enums\PaymentMethodType;
use App\Enums\PaymentProviderCode;
use App\Enums\PaymentProviderState;
use App\Enums\PresetIdentification;
use App\Enums\PresetServiceAt;
use App\Enums\PrinterType;
use App\Enums\QrCodeMethod;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\SequencePurpose;
use App\Enums\TaxDisplay;
use App\Enums\TerminalProvider;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * The three registers of the bistro and everything they point at: payment
 * methods, EUR denominations, presets with service windows, printers, kitchen
 * notes and per-config sequences.
 *
 *  - "Salle"              — full restaurant mode, floors, presets, tips, KDS;
 *  - "Bar"                — restaurant mode on the terrace only, fast payments;
 *  - "Comptoir / À emporter" — counter sale, no tables, takeaway fiscal position.
 */
class PosConfigSeeder extends Seeder
{
    public const CONFIG_ROOM = 'Salle';

    public const CONFIG_BAR = 'Bar';

    public const CONFIG_COUNTER = 'Comptoir / À emporter';

    public const PM_CASH = 'Espèces';

    public const PM_CARD = 'Carte bancaire';

    public const PM_MEAL_VOUCHER = 'Ticket Restaurant';

    public const PM_HOLIDAY_VOUCHER = 'Chèque-vacances';

    public const PM_LATER = 'Payer plus tard';

    public const PM_ONLINE = 'Paiement en ligne';

    public const PRESET_DINE_IN = 'Sur place';

    public const PRESET_TAKEAWAY = 'À emporter';

    public const PRESET_DELIVERY = 'Livraison';

    private int $companyId;

    private int $currencyId;

    private string $now;

    public function run(): void
    {
        Demo::reseed('posconfig');

        $companyId = DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === null) {
            return;
        }
        $this->companyId = (int) $companyId;
        $this->currencyId = (int) DB::table('currencies')->where('code', 'EUR')->value('id');
        $this->now = Demo::ts(Demo::clock());

        if (DB::table('pos_configs')->where('company_id', $this->companyId)->exists()) {
            return;
        }

        $templates = $this->seedNotificationTemplates();
        $methods = $this->seedPaymentMethods();
        $this->seedBills();
        $notes = $this->seedNotes();
        $presets = $this->seedPresets();
        $printers = $this->seedPrinters();

        $this->seedConfigs($methods, $notes, $presets, $printers, $templates);
    }

    /** @return array<string, int> */
    private function seedNotificationTemplates(): array
    {
        $frenchId = DB::table('languages')->where('code', 'fr_FR')->value('id');

        /** @var list<array{0:string,1:NotificationChannel,2:NotificationPurpose,3:?string,4:string}> $rows */
        $rows = [
            ['Ticket par e-mail', NotificationChannel::Email, NotificationPurpose::Receipt,
                'Votre ticket — Le Bistro Numérique',
                "Bonjour {{customer_name}},\n\nVoici votre ticket n° {{order_name}} du {{order_date}} pour un total de {{order_total}}.\n\nÀ bientôt !\nLe Bistro Numérique"],
            ['Ticket par SMS', NotificationChannel::Sms, NotificationPurpose::Receipt, null,
                'Bistro Numérique — ticket {{order_name}} : {{order_total}}. Détail : {{receipt_url}}'],
            ['Confirmation commande en ligne', NotificationChannel::Email, NotificationPurpose::SelfOrderConfirmation,
                'Commande {{tracking_number}} confirmée',
                'Merci ! Votre commande {{tracking_number}} est confirmée et sera prête vers {{ready_at}}.'],
            ['Carte cadeau émise', NotificationChannel::Email, NotificationPurpose::GiftCard,
                'Votre carte cadeau Le Bistro Numérique',
                "Voici votre carte cadeau d'une valeur de {{card_value}}. Code : {{card_code}}."],
            ['Points de fidélité', NotificationChannel::Email, NotificationPurpose::Loyalty,
                'Vos points fidélité',
                'Vous cumulez {{points_balance}} points, soit {{points_value}} de remise disponible.'],
        ];

        $ids = [];
        foreach ($rows as [$name, $channel, $purpose, $subject, $body]) {
            $ids[$name] = (int) DB::table('notification_templates')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $name,
                'channel' => $channel->value,
                'purpose' => $purpose->value,
                'subject' => $subject,
                'body' => $body,
                'attach_receipt_image' => $purpose === NotificationPurpose::Receipt && $channel === NotificationChannel::Email,
                'attach_invoice_pdf' => false,
                'language_id' => $frenchId,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        return $ids;
    }

    /** @return array<string, int> */
    private function seedPaymentMethods(): array
    {
        $providerId = (int) DB::table('payment_providers')->insertGetId([
            'company_id' => $this->companyId,
            'name' => 'Stripe (démo)',
            'code' => PaymentProviderCode::Stripe->value,
            'state' => PaymentProviderState::Test->value,
            'credentials' => json_encode(['publishable_key' => 'pk_test_bistro', 'secret_key' => 'sk_test_bistro'], JSON_THROW_ON_ERROR),
            'requires_customer_email' => true,
            'supported_currencies' => json_encode(['EUR'], JSON_THROW_ON_ERROR),
            'sequence' => 10,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        /** @var list<array<string, mixed>> $rows */
        $rows = [
            [
                'name' => self::PM_CASH, 'method_type' => PaymentMethodType::Cash, 'cash' => true,
                'change' => true, 'rounding_target' => true, 'identify' => false,
                'terminal' => TerminalProvider::None, 'provider' => null, 'ledger' => '5311',
                'qr' => QrCodeMethod::None, 'sequence' => 10,
            ],
            [
                'name' => self::PM_CARD, 'method_type' => PaymentMethodType::CardTerminal, 'cash' => false,
                'change' => false, 'rounding_target' => false, 'identify' => false,
                'terminal' => TerminalProvider::Stripe, 'provider' => $providerId, 'ledger' => '5112',
                'qr' => QrCodeMethod::None, 'sequence' => 20,
            ],
            [
                'name' => self::PM_MEAL_VOUCHER, 'method_type' => PaymentMethodType::Voucher, 'cash' => false,
                'change' => false, 'rounding_target' => false, 'identify' => false,
                'terminal' => TerminalProvider::None, 'provider' => null, 'ledger' => '5115',
                'qr' => QrCodeMethod::None, 'sequence' => 30,
            ],
            [
                'name' => self::PM_HOLIDAY_VOUCHER, 'method_type' => PaymentMethodType::Voucher, 'cash' => false,
                'change' => false, 'rounding_target' => false, 'identify' => false,
                'terminal' => TerminalProvider::None, 'provider' => null, 'ledger' => '5116',
                'qr' => QrCodeMethod::None, 'sequence' => 40,
            ],
            [
                'name' => self::PM_LATER, 'method_type' => PaymentMethodType::CustomerAccount, 'cash' => false,
                'change' => false, 'rounding_target' => false, 'identify' => true,
                'terminal' => TerminalProvider::None, 'provider' => null, 'ledger' => '4111',
                'qr' => QrCodeMethod::None, 'sequence' => 50,
            ],
            [
                'name' => self::PM_ONLINE, 'method_type' => PaymentMethodType::Online, 'cash' => false,
                'change' => false, 'rounding_target' => false, 'identify' => true,
                'terminal' => TerminalProvider::None, 'provider' => $providerId, 'ledger' => '5113',
                'qr' => QrCodeMethod::Emv, 'sequence' => 60,
            ],
        ];

        $ids = [];
        foreach ($rows as $row) {
            $ids[$row['name']] = (int) DB::table('payment_methods')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $row['name'],
                'method_type' => $row['method_type']->value,
                'is_cash_count' => $row['cash'],
                'currency_id' => $this->currencyId,
                'identify_customer' => $row['identify'],
                'allow_change' => $row['change'],
                'allow_refund' => $row['name'] !== self::PM_MEAL_VOUCHER,
                'is_rounding_target' => $row['rounding_target'],
                'terminal_provider' => $row['terminal']->value,
                'terminal_config' => $row['terminal'] === TerminalProvider::None
                    ? null
                    : json_encode(['terminal_id' => 'TERM-'.strtoupper(Demo::token('term:'.$row['name'], 6))], JSON_THROW_ON_ERROR),
                'qr_code_method' => $row['qr']->value,
                'payment_provider_id' => $row['provider'],
                'ledger_code' => $row['ledger'],
                'sequence' => $row['sequence'],
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        return $ids;
    }

    private function seedBills(): void
    {
        /** @var list<array{0:string,1:string,2:DenominationType}> $denominations */
        $denominations = [
            ['1 centime', '0.0100', DenominationType::Coin],
            ['2 centimes', '0.0200', DenominationType::Coin],
            ['5 centimes', '0.0500', DenominationType::Coin],
            ['10 centimes', '0.1000', DenominationType::Coin],
            ['20 centimes', '0.2000', DenominationType::Coin],
            ['50 centimes', '0.5000', DenominationType::Coin],
            ['1 €', '1.0000', DenominationType::Coin],
            ['2 €', '2.0000', DenominationType::Coin],
            ['5 €', '5.0000', DenominationType::Bill],
            ['10 €', '10.0000', DenominationType::Bill],
            ['20 €', '20.0000', DenominationType::Bill],
            ['50 €', '50.0000', DenominationType::Bill],
            ['100 €', '100.0000', DenominationType::Bill],
            ['200 €', '200.0000', DenominationType::Bill],
        ];

        $payload = [];
        foreach ($denominations as $index => [$name, $value, $type]) {
            $payload[] = [
                'company_id' => $this->companyId,
                'currency_id' => $this->currencyId,
                'name' => $name,
                'value' => $value,
                'denomination_type' => $type->value,
                'sequence' => ($index + 1) * 10,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
        }
        DB::table('pos_bills')->insert($payload);
    }

    /** @return array<string, int> */
    private function seedNotes(): array
    {
        /** @var list<array{0:string,1:int,2:NoteScope}> $rows */
        $rows = [
            ['Sans oignons', 1, NoteScope::Line],
            ['Sans gluten (allergie)', 2, NoteScope::Both],
            ['Allergie fruits à coque', 3, NoteScope::Both],
            ['Allergie lactose', 4, NoteScope::Both],
            ['Cuisson : saignant', 5, NoteScope::Line],
            ['Cuisson : à point', 6, NoteScope::Line],
            ['Cuisson : bien cuit', 7, NoteScope::Line],
            ['Sans sauce', 8, NoteScope::Line],
            ['Sauce à part', 9, NoteScope::Line],
            ['Bien chaud', 10, NoteScope::Line],
            ['Sans glace', 11, NoteScope::Line],
            ['À emporter', 1, NoteScope::Order],
            ['À partager', 2, NoteScope::Order],
            ['Servir en même temps', 3, NoteScope::Order],
            ['Client pressé', 4, NoteScope::Order],
        ];

        $ids = [];
        foreach ($rows as $index => [$name, $color, $scope]) {
            $ids[$name] = (int) DB::table('pos_notes')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $name,
                'color' => $color,
                'note_scope' => $scope->value,
                'sequence' => ($index + 1),
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }

        return $ids;
    }

    /** @return array<string, int> */
    private function seedPresets(): array
    {
        $takeawayFiscalId = DB::table('fiscal_positions')
            ->where('company_id', $this->companyId)
            ->where('name', TaxSeeder::FP_TAKEAWAY)
            ->value('id');

        $terracePricelistId = DB::table('pricelists')
            ->where('company_id', $this->companyId)
            ->where('name', PricelistSeeder::TERRACE)
            ->value('id');

        $confirmationTemplateId = DB::table('notification_templates')
            ->where('company_id', $this->companyId)
            ->where('name', 'Confirmation commande en ligne')
            ->value('id');

        /** @var list<array<string, mixed>> $rows */
        $rows = [
            [
                'name' => self::PRESET_DINE_IN, 'service_at' => PresetServiceAt::Table,
                'identification' => PresetIdentification::None, 'guest' => true, 'timing' => false,
                'fiscal' => null, 'pricelist' => null, 'self' => true, 'color' => 4, 'sequence' => 10,
            ],
            [
                'name' => self::PRESET_TAKEAWAY, 'service_at' => PresetServiceAt::Counter,
                'identification' => PresetIdentification::Name, 'guest' => false, 'timing' => true,
                'fiscal' => $takeawayFiscalId, 'pricelist' => null, 'self' => true, 'color' => 6, 'sequence' => 20,
            ],
            [
                'name' => self::PRESET_DELIVERY, 'service_at' => PresetServiceAt::Delivery,
                'identification' => PresetIdentification::Address, 'guest' => false, 'timing' => true,
                'fiscal' => $takeawayFiscalId, 'pricelist' => null, 'self' => false, 'color' => 9, 'sequence' => 30,
            ],
            [
                'name' => 'Terrasse', 'service_at' => PresetServiceAt::Table,
                'identification' => PresetIdentification::None, 'guest' => true, 'timing' => false,
                'fiscal' => null, 'pricelist' => $terracePricelistId, 'self' => true, 'color' => 2, 'sequence' => 40,
            ],
        ];

        $ids = [];
        foreach ($rows as $row) {
            $presetId = (int) DB::table('pos_presets')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $row['name'],
                'pricelist_id' => $row['pricelist'],
                'fiscal_position_id' => $row['fiscal'],
                'identification' => $row['identification']->value,
                'is_return' => false,
                'use_guest' => $row['guest'],
                'color' => $row['color'],
                'sequence' => $row['sequence'],
                'use_timing' => $row['timing'],
                'slots_per_interval' => $row['timing'] ? 4 : 5,
                'interval_minutes' => $row['timing'] ? 15 : 20,
                'available_in_self' => $row['self'],
                'service_at' => $row['service_at']->value,
                'notification_template_id' => $row['timing'] ? $confirmationTemplateId : null,
                'is_system' => $row['name'] === self::PRESET_DINE_IN,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $ids[$row['name']] = $presetId;

            $this->seedServiceWindows($presetId, (bool) $row['timing']);
        }

        return $ids;
    }

    /** Lunch and dinner, Monday (0) through Sunday (6); Sunday has no dinner service. */
    private function seedServiceWindows(int $presetId, bool $extendedEvening): void
    {
        $payload = [];
        for ($day = 0; $day <= 6; $day++) {
            $payload[] = [
                'pos_preset_id' => $presetId,
                'day_of_week' => $day,
                'hour_from' => '12.00',
                'hour_to' => $day >= 5 ? '15.00' : '14.50',
                'day_period' => DayPeriod::Morning->value,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];

            if ($day === 6) {
                continue; // Sunday evening: closed.
            }

            $payload[] = [
                'pos_preset_id' => $presetId,
                'day_of_week' => $day,
                'hour_from' => '19.00',
                'hour_to' => $extendedEvening ? '22.50' : ($day >= 4 ? '23.75' : '23.00'),
                'day_period' => DayPeriod::Evening->value,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
        }
        DB::table('preset_service_windows')->insert($payload);
    }

    /** @return array<string, int> */
    private function seedPrinters(): array
    {
        $categories = DB::table('pos_categories')
            ->where('company_id', $this->companyId)
            ->pluck('id', 'name');

        /** @var list<array{0:string,1:PrinterType,2:bool,3:bool,4:list<string>,5:?string}> $rows */
        $rows = [
            ['Imprimante caisse (salle)', PrinterType::EpsonEpos, true, false, [], '192.168.1.51'],
            ['Imprimante cuisine chaude', PrinterType::NetworkEscpos, false, false,
                ['Entrées', 'Plats', 'Tajines', 'Pizzas', 'Burgers', 'Menus'], '192.168.1.52'],
            ['Imprimante bar', PrinterType::NetworkEscpos, false, false,
                ['Boissons chaudes', 'Boissons fraîches', 'Bières', 'Vins', 'Cocktails'], '192.168.1.53'],
            ['Imprimante comptoir', PrinterType::EpsonEpos, true, true, [], '192.168.1.54'],
        ];

        $ids = [];
        foreach ($rows as [$name, $type, $isReceipt, $allCategories, $categoryNames, $ip]) {
            $printerId = (int) DB::table('pos_printers')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $name,
                'printer_type' => $type->value,
                'proxy_ip' => $type === PrinterType::Iot ? '192.168.1.10' : null,
                'printer_ip' => $ip,
                'printer_port' => $type === PrinterType::NetworkEscpos ? 9100 : null,
                'serial_number' => strtoupper(Demo::token('printer:'.$name, 10)),
                'is_receipt_printer' => $isReceipt,
                'print_all_categories' => $allCategories,
                'characters_per_line' => 42,
                'copies' => 1,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $ids[$name] = $printerId;

            foreach ($categoryNames as $categoryName) {
                DB::table('pos_category_pos_printer')->insert([
                    'pos_printer_id' => $printerId,
                    'pos_category_id' => $categories[$categoryName],
                ]);
            }
        }

        return $ids;
    }

    /**
     * @param  array<string, int>  $methods
     * @param  array<string, int>  $notes
     * @param  array<string, int>  $presets
     * @param  array<string, int>  $printers
     * @param  array<string, int>  $templates
     */
    private function seedConfigs(array $methods, array $notes, array $presets, array $printers, array $templates): void
    {
        $pricelists = DB::table('pricelists')->where('company_id', $this->companyId)->pluck('id', 'name');
        $fiscalPositions = DB::table('fiscal_positions')->where('company_id', $this->companyId)->pluck('id', 'name');
        $languages = DB::table('languages')->pluck('id', 'code');
        $nomenclatureId = DB::table('barcode_nomenclatures')->where('company_id', $this->companyId)->value('id');
        $cashRoundingId = DB::table('cash_roundings')
            ->where('company_id', $this->companyId)
            ->where('name', 'Arrondi 5 centimes (espèces)')->value('id');

        $tipProductId = DB::table('products')->where('company_id', $this->companyId)->where('name', 'Pourboire')->value('id');
        $discountProductId = DB::table('products')->where('company_id', $this->companyId)->where('name', 'Remise globale')->value('id');

        $kitchenCategories = ['Entrées', 'Plats', 'Tajines', 'Pizzas', 'Burgers', 'Desserts', 'Menus'];
        $barCategories = ['Boissons chaudes', 'Boissons fraîches', 'Bières', 'Vins', 'Cocktails'];

        /** @var list<array<string, mixed>> $configs */
        $configs = [
            [
                'name' => self::CONFIG_ROOM,
                'restaurant' => true,
                'screen' => DefaultScreen::Tables,
                'methods' => [self::PM_CASH, self::PM_CARD, self::PM_MEAL_VOUCHER, self::PM_HOLIDAY_VOUCHER, self::PM_LATER, self::PM_ONLINE],
                'fast' => [],
                'presets' => [self::PRESET_DINE_IN, self::PRESET_TAKEAWAY, self::PRESET_DELIVERY, 'Terrasse'],
                'defaultPreset' => self::PRESET_DINE_IN,
                'printers' => ['Imprimante caisse (salle)', 'Imprimante cuisine chaude', 'Imprimante bar'],
                'categories' => [],
                'tips' => true,
                'cashControl' => true,
                'prepDisplay' => true,
                'limitCategories' => false,
            ],
            [
                'name' => self::CONFIG_BAR,
                'restaurant' => true,
                'screen' => DefaultScreen::Register,
                'methods' => [self::PM_CASH, self::PM_CARD, self::PM_LATER],
                'fast' => [self::PM_CASH, self::PM_CARD],
                'presets' => [self::PRESET_DINE_IN, 'Terrasse'],
                'defaultPreset' => 'Terrasse',
                'printers' => ['Imprimante bar'],
                'categories' => $barCategories,
                'tips' => true,
                'cashControl' => true,
                'prepDisplay' => true,
                'limitCategories' => true,
            ],
            [
                'name' => self::CONFIG_COUNTER,
                'restaurant' => false,
                'screen' => DefaultScreen::Register,
                'methods' => [self::PM_CASH, self::PM_CARD, self::PM_MEAL_VOUCHER, self::PM_ONLINE],
                'fast' => [self::PM_CASH, self::PM_CARD],
                'presets' => [self::PRESET_TAKEAWAY, self::PRESET_DELIVERY],
                'defaultPreset' => self::PRESET_TAKEAWAY,
                'printers' => ['Imprimante comptoir', 'Imprimante cuisine chaude'],
                'categories' => array_merge($kitchenCategories, $barCategories),
                'tips' => false,
                'cashControl' => true,
                'prepDisplay' => true,
                'limitCategories' => false,
            ],
        ];

        $employees = DB::table('employees')->where('company_id', $this->companyId)->get();
        $categoryIds = DB::table('pos_categories')->where('company_id', $this->companyId)->pluck('id', 'name');
        $configIds = [];

        foreach ($configs as $index => $config) {
            /** @var string $name */
            $name = $config['name'];

            $configId = (int) DB::table('pos_configs')->insertGetId([
                'uuid' => Demo::uuid('config:'.Demo::slug($name)),
                'company_id' => $this->companyId,
                'name' => $name,
                'access_token' => Demo::token('config:'.Demo::slug($name), 32),
                'currency_id' => $this->currencyId,
                'cash_rounding_id' => $cashRoundingId,
                'use_cash_rounding' => false,
                'only_round_cash_payments' => true,
                'config_revision' => 1,
                'last_config_change_at' => Demo::ms(Demo::clock()),
                'active' => true,

                'pricelist_id' => $pricelists[PricelistSeeder::PUBLIC],
                'use_pricelists' => true,
                'limit_categories' => $config['limitCategories'],
                'tax_display' => TaxDisplay::Total->value,
                'use_fiscal_positions' => true,
                'default_fiscal_position_id' => $name === self::CONFIG_COUNTER
                    ? $fiscalPositions[TaxSeeder::FP_TAKEAWAY]
                    : null,
                'show_product_images' => true,
                'show_category_images' => true,
                'group_products_by_category' => $name !== self::CONFIG_BAR,
                'allow_manual_discount' => true,
                'restrict_price_control' => $name === self::CONFIG_COUNTER,
                'show_margins_to_all' => false,

                'use_presets' => true,
                'default_preset_id' => $presets[$config['defaultPreset']],
                'enable_tips' => $config['tips'],
                'tip_product_id' => $config['tips'] ? $tipProductId : null,
                'tip_after_payment' => false,

                'has_cash_control' => $config['cashControl'],
                'set_maximum_difference' => true,
                'amount_authorized_diff' => '5.0000',
                'auto_validate_terminal_payment' => true,
                'use_fast_payment' => $config['fast'] !== [],
                'self_order_online_payment_method_id' => in_array(self::PM_ONLINE, $config['methods'], true)
                    ? $methods[self::PM_ONLINE]
                    : null,

                'show_receipt_header_footer' => true,
                'receipt_header' => "Le Bistro Numérique\n12 rue des Abbesses — 75018 Paris\nTVA FR40123456824",
                'receipt_footer' => "Merci de votre visite !\nbistronumerique.fr",
                'basic_receipt' => false,
                'auto_print_receipt' => $name === self::CONFIG_COUNTER,
                'skip_receipt_screen' => $name === self::CONFIG_BAR,

                'is_restaurant' => $config['restaurant'],
                'enable_split_bill' => $config['restaurant'],
                'enable_bill_print' => $config['restaurant'],
                'default_screen' => $config['screen']->value,
                'idle_return_seconds' => 180,

                'use_preparation_printers' => true,
                'use_preparation_display' => $config['prepDisplay'],
                'prep_auto_fire_first_course' => true,

                'use_iot_box' => false,
                'use_epos_printer' => true,
                'epos_printer_ip' => '192.168.1.5'.($index + 1),
                'big_scrollbars' => false,

                'fallback_barcode_nomenclature_id' => $nomenclatureId,

                'self_ordering_mode' => SelfOrderMode::Nothing->value,
                'self_ordering_service_mode' => $config['restaurant']
                    ? SelfOrderServiceMode::Table->value
                    : SelfOrderServiceMode::Counter->value,
                'self_ordering_pay_after' => SelfOrderPayAfter::Each->value,
                'self_ordering_default_language_id' => $languages['fr_FR'],
                'self_ordering_brand_name' => Demo::COMPANY_NAME,
                'self_ordering_primary_color' => '#8C1C13',
                'self_ordering_text_color' => '#FFF8F0',
                'kiosk_idle_seconds' => 90,
                'kiosk_confirmation_seconds' => 30,

                'enable_global_discount' => true,
                'global_discount_percent' => '10.0000',
                'global_discount_product_id' => $discountProductId,

                'use_employee_login' => true,
                'enable_loyalty' => true,
                'enable_sms_receipt' => true,
                'sms_template_id' => $templates['Ticket par SMS'],
                'email_receipt_template_id' => $templates['Ticket par e-mail'],
                'order_edit_tracking' => true,
                'limited_product_count' => 5000,
                'limited_customer_count' => 200,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $configIds[$name] = $configId;

            foreach ($config['methods'] as $methodIndex => $methodName) {
                DB::table('pos_config_payment_method')->insert([
                    'pos_config_id' => $configId,
                    'payment_method_id' => $methods[$methodName],
                    'sequence' => ($methodIndex + 1) * 10,
                    'is_fast_payment' => in_array($methodName, $config['fast'], true),
                ]);
            }

            foreach ([PricelistSeeder::PUBLIC, PricelistSeeder::HAPPY_HOUR, PricelistSeeder::TERRACE] as $pricelistName) {
                DB::table('pos_config_pricelist')->insert([
                    'pos_config_id' => $configId,
                    'pricelist_id' => $pricelists[$pricelistName],
                ]);
            }

            foreach ([TaxSeeder::FP_TAKEAWAY, TaxSeeder::FP_EXPORT] as $fiscalName) {
                DB::table('pos_config_fiscal_position')->insert([
                    'pos_config_id' => $configId,
                    'fiscal_position_id' => $fiscalPositions[$fiscalName],
                ]);
            }

            foreach ($config['presets'] as $presetIndex => $presetName) {
                DB::table('pos_config_preset')->insert([
                    'pos_config_id' => $configId,
                    'pos_preset_id' => $presets[$presetName],
                    'sequence' => ($presetIndex + 1) * 10,
                ]);
            }

            foreach ($config['printers'] as $printerName) {
                DB::table('pos_config_printer')->insert([
                    'pos_config_id' => $configId,
                    'pos_printer_id' => $printers[$printerName],
                ]);
            }

            foreach (array_values($notes) as $noteId) {
                DB::table('pos_config_note')->insert([
                    'pos_config_id' => $configId,
                    'pos_note_id' => $noteId,
                ]);
            }

            foreach ($config['categories'] as $categoryName) {
                DB::table('pos_config_pos_category')->insert([
                    'pos_config_id' => $configId,
                    'pos_category_id' => $categoryIds[$categoryName],
                ]);
            }

            foreach (['fr_FR', 'en_US', 'ar_MA'] as $languageIndex => $languageCode) {
                DB::table('pos_config_language')->insert([
                    'pos_config_id' => $configId,
                    'language_id' => $languages[$languageCode],
                    'sequence' => ($languageIndex + 1) * 10,
                ]);
            }

            foreach ($employees as $employee) {
                DB::table('pos_config_employee')->insert([
                    'pos_config_id' => $configId,
                    'employee_id' => $employee->id,
                    'access_level' => match ($employee->default_role) {
                        'manager' => AccessLevel::Advanced->value,
                        'cashier' => AccessLevel::Basic->value,
                        default => AccessLevel::Minimal->value,
                    },
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }

            $this->seedDevices($configId, $name);
            $this->seedSequences($configId, $name);
        }

        // Salle and Bar share their open orders; the counter does not.
        $this->trustEachOther($configIds[self::CONFIG_ROOM], $configIds[self::CONFIG_BAR]);

        // Company-level invoice counter.
        DB::table('sequences')->insert([
            'company_id' => $this->companyId,
            'pos_config_id' => null,
            'purpose' => SequencePurpose::Invoice->value,
            'period_key' => Demo::clock()->format('Y'),
            'prefix' => 'FA-'.Demo::clock()->format('Y').'-',
            'padding' => 5,
            'next_value' => 1,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);
    }

    private function seedDevices(int $configId, string $configName): void
    {
        $slug = Demo::slug($configName);

        DB::table('pos_devices')->insert([
            [
                'uuid' => Demo::uuid('device:'.$slug.':1'),
                'pos_config_id' => $configId,
                'device_identifier' => 1,
                'name' => 'Caisse '.$configName,
                'device_type' => DeviceType::Register->value,
                'user_agent' => 'Mozilla/5.0 (X11; Linux x86_64) RestoPOS/1.0 Chrome/126',
                'last_seen_at' => Demo::ts(Demo::clock()),
                'last_synced_at' => Demo::ms(Demo::clock()),
                'has_paper' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
            [
                'uuid' => Demo::uuid('device:'.$slug.':2'),
                'pos_config_id' => $configId,
                'device_identifier' => 2,
                'name' => 'Afficheur client '.$configName,
                'device_type' => DeviceType::CustomerDisplay->value,
                'user_agent' => 'Mozilla/5.0 (X11; Linux x86_64) RestoPOS-Display/1.0',
                'last_seen_at' => Demo::ts(Demo::clock()),
                'last_synced_at' => Demo::ms(Demo::clock()),
                'has_paper' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
        ]);
    }

    private function seedSequences(int $configId, string $configName): void
    {
        $prefix = match ($configName) {
            self::CONFIG_ROOM => 'SAL',
            self::CONFIG_BAR => 'BAR',
            default => 'CPT',
        };

        $payload = [];
        /** @var list<array{0:SequencePurpose,1:string,2:int}> $purposes */
        $purposes = [
            [SequencePurpose::Order, $prefix.'-', 5],
            [SequencePurpose::Receipt, $prefix.'/T', 6],
            [SequencePurpose::Session, $prefix.'/S', 4],
            [SequencePurpose::Refund, $prefix.'/R', 4],
            [SequencePurpose::Device, $prefix.'/D', 3],
            [SequencePurpose::OrderLine, $prefix.'/L', 8],
        ];

        foreach ($purposes as [$purpose, $sequencePrefix, $padding]) {
            $payload[] = [
                'company_id' => $this->companyId,
                'pos_config_id' => $configId,
                'purpose' => $purpose->value,
                'period_key' => null,
                'prefix' => $sequencePrefix,
                'padding' => $padding,
                'next_value' => 1,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
        }
        DB::table('sequences')->insert($payload);
    }

    private function trustEachOther(int $left, int $right): void
    {
        DB::table('pos_config_trusted_config')->insert([
            ['pos_config_id' => $left, 'trusted_config_id' => $right],
            ['pos_config_id' => $right, 'trusted_config_id' => $left],
        ]);
    }
}
