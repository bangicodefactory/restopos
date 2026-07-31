<?php

declare(strict_types=1);

namespace Database\Factories\Pos;

use App\Enums\DefaultScreen;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\TaxDisplay;
use App\Models\Pos\PosConfig;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<PosConfig>
 */
class PosConfigFactory extends Factory
{
    protected $model = PosConfig::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        return [
            'uuid' => (string) Str::uuid(),
            'company_id' => Reference::companyId(),
            'name' => 'Caisse '.$this->faker->unique()->word(),
            'access_token' => Str::random(32),
            'currency_id' => Reference::currencyId(),
            'use_cash_rounding' => false,
            'only_round_cash_payments' => true,
            'config_revision' => 1,
            'active' => true,
            'use_pricelists' => false,
            'limit_categories' => false,
            'tax_display' => TaxDisplay::Subtotal->value,
            'use_fiscal_positions' => false,
            'show_product_images' => true,
            'show_category_images' => true,
            'allow_manual_discount' => true,
            'use_presets' => false,
            'enable_tips' => false,
            'has_cash_control' => false,
            'is_restaurant' => false,
            'default_screen' => DefaultScreen::Register->value,
            'use_preparation_printers' => false,
            'use_preparation_display' => false,
            'self_ordering_mode' => SelfOrderMode::Nothing->value,
            'self_ordering_service_mode' => SelfOrderServiceMode::Counter->value,
            'self_ordering_pay_after' => SelfOrderPayAfter::Each->value,
            'use_employee_login' => false,
            'enable_loyalty' => false,
            'order_edit_tracking' => false,
            'limited_product_count' => 5000,
            'limited_customer_count' => 100,
        ];
    }

    /** Table service: floors, split bills, the tables screen. */
    public function restaurant(): static
    {
        return $this->state(fn (): array => [
            'is_restaurant' => true,
            'default_screen' => DefaultScreen::Tables->value,
            'enable_split_bill' => true,
            'enable_bill_print' => true,
            'use_preparation_display' => true,
        ]);
    }

    public function withCashControl(): static
    {
        return $this->state(fn (): array => [
            'has_cash_control' => true,
            'cash_rounding_id' => Reference::cashRoundingId(),
        ]);
    }

    public function selfOrder(SelfOrderMode $mode = SelfOrderMode::Mobile): static
    {
        return $this->state(fn (): array => [
            'self_ordering_mode' => $mode->value,
            'self_ordering_service_mode' => $mode === SelfOrderMode::Kiosk
                ? SelfOrderServiceMode::Counter->value
                : SelfOrderServiceMode::Table->value,
        ]);
    }
}
