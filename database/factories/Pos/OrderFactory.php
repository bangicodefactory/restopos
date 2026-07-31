<?php

declare(strict_types=1);

namespace Database\Factories\Pos;

use App\Enums\OrderPrepState;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\PosSession;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * @extends Factory<Order>
 *
 * Amounts default to zero: the server always recomputes them from the lines
 * (docs/CONVENTIONS.md § sync contract), so a test that cares about totals
 * should run the tax engine rather than hand-write them here.
 */
class OrderFactory extends Factory
{
    protected $model = Order::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $session = PosSession::query()->latest('id')->first() ?? PosSessionFactory::new()->create();
        $orderedAt = Carbon::now();

        return [
            'uuid' => (string) Str::uuid(),
            'pos_session_id' => $session->id,
            'pos_config_id' => $session->pos_config_id,
            'company_id' => $session->company_id,
            'name' => 'ORD-'.$this->faker->unique()->numerify('#####'),
            'tracking_number' => $this->faker->numerify('###'),
            'access_token' => (string) Str::uuid(),
            'source' => OrderSource::Pos->value,
            'state' => OrderState::Draft->value,
            'ordered_at' => $orderedAt,
            'currency_id' => $session->currency_id,
            'currency_rate' => 1,
            'amount_untaxed' => 0,
            'amount_tax' => 0,
            'amount_total' => 0,
            'amount_rounding' => 0,
            'amount_paid' => 0,
            'amount_change' => 0,
            'amount_due' => 0,
            'amount_discount' => 0,
            'total_cost' => 0,
            'margin' => 0,
            'margin_percent' => 0,
            'guest_count' => 0,
            'is_tipped' => false,
            'tip_amount' => 0,
            'is_refund' => false,
            'refund_count' => 0,
            'has_refundable_lines' => true,
            'to_invoice' => false,
            'prep_state' => OrderPrepState::None->value,
            'unsent_change_count' => 0,
            'print_count' => 0,
            'is_edited' => false,
            'has_deleted_line' => false,
        ];
    }

    public function paid(): static
    {
        return $this->state(fn (array $attributes): array => [
            'state' => OrderState::Paid->value,
            'paid_at' => Carbon::parse($attributes['ordered_at'])->addMinutes(30),
        ]);
    }

    public function done(): static
    {
        return $this->state(fn (array $attributes): array => [
            'state' => OrderState::Done->value,
            'paid_at' => Carbon::parse($attributes['ordered_at'])->addMinutes(30),
            'closed_at' => Carbon::parse($attributes['ordered_at'])->addMinutes(31),
        ]);
    }

    public function cancelled(string $reason = 'Annulée par le caissier'): static
    {
        return $this->state(fn (): array => [
            'state' => OrderState::Cancelled->value,
            'cancelled_at' => Carbon::now(),
            'cancel_reason' => $reason,
        ]);
    }

    public function refundOf(Order $original): static
    {
        return $this->state(fn (): array => [
            'is_refund' => true,
            'refunded_order_id' => $original->id,
            'has_refundable_lines' => false,
        ]);
    }

    public function onTable(int $tableId, int $guests = 2): static
    {
        return $this->state(fn (): array => [
            'restaurant_table_id' => $tableId,
            'guest_count' => $guests,
        ]);
    }

    public function tipped(float $amount = 2.0): static
    {
        return $this->state(fn (): array => ['is_tipped' => true, 'tip_amount' => $amount]);
    }
}
