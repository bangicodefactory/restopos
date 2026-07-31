<?php

declare(strict_types=1);

namespace Database\Factories\Pos;

use App\Enums\SessionState;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * @extends Factory<PosSession>
 */
class PosSessionFactory extends Factory
{
    protected $model = PosSession::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $openedAt = Carbon::now()->subHours(4);

        return [
            'uuid' => (string) Str::uuid(),
            'pos_config_id' => PosConfig::query()->value('id') ?? PosConfigFactory::new(),
            'company_id' => fn (array $attributes): int => (int) PosConfig::query()
                ->whereKey($attributes['pos_config_id'])->value('company_id'),
            'currency_id' => fn (array $attributes): int => (int) PosConfig::query()
                ->whereKey($attributes['pos_config_id'])->value('currency_id'),
            'name' => 'S'.$this->faker->unique()->numerify('####'),
            'state' => SessionState::Opened->value,
            'opened_at' => $openedAt,
            'business_date' => $openedAt->toDateString(),
            'has_cash_control' => false,
            'cash_balance_opening' => 0,
            'cash_balance_opening_expected' => 0,
            'cash_balance_closing_expected' => 0,
            'cash_difference' => 0,
            'cash_in_total' => 0,
            'cash_out_total' => 0,
            'order_count' => 0,
            'order_amount_total' => 0,
            'refund_amount_total' => 0,
            'payments_total' => 0,
            'is_rescue' => false,
            'closing_forced' => false,
        ];
    }

    public function opening(): static
    {
        return $this->state(fn (): array => ['state' => SessionState::OpeningControl->value]);
    }

    public function closed(): static
    {
        return $this->state(fn (array $attributes): array => [
            'state' => SessionState::Closed->value,
            'closed_at' => Carbon::parse($attributes['opened_at'])->addHours(8),
            'cash_balance_closing_counted' => $attributes['cash_balance_opening'] ?? 0,
        ]);
    }

    public function withCashControl(float $float = 200.0): static
    {
        return $this->state(fn (): array => [
            'has_cash_control' => true,
            'cash_balance_opening' => $float,
            'cash_balance_opening_expected' => $float,
        ]);
    }
}
