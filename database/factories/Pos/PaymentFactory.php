<?php

declare(strict_types=1);

namespace Database\Factories\Pos;

use App\Enums\PaymentStatus;
use App\Models\Pos\Order;
use App\Models\Pos\Payment;
use Database\Factories\Support\Reference;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * @extends Factory<Payment>
 *
 * The `pos_payments` row an order settles with. Negative amounts are change
 * (`is_change`) or refunds (`is_refund`), never a separate table.
 */
class PaymentFactory extends Factory
{
    protected $model = Payment::class;

    /** @return array<string, mixed> */
    public function definition(): array
    {
        $order = Order::query()->latest('id')->first() ?? OrderFactory::new()->create();
        $amount = (float) $order->amount_total;

        return [
            'uuid' => (string) Str::uuid(),
            'pos_order_id' => $order->id,
            'pos_session_id' => $order->pos_session_id,
            'payment_method_id' => Reference::paymentMethodId(),
            'company_id' => $order->company_id,
            'currency_id' => $order->currency_id,
            'amount' => $amount,
            'amount_company_currency' => $amount,
            'is_change' => false,
            'is_refund' => false,
            'paid_at' => Carbon::now(),
            'payment_status' => PaymentStatus::Done->value,
        ];
    }

    public function amount(float $amount): static
    {
        return $this->state(fn (): array => [
            'amount' => $amount,
            'amount_company_currency' => $amount,
        ]);
    }

    public function change(float $amount): static
    {
        return $this->state(fn (): array => [
            'amount' => -abs($amount),
            'amount_company_currency' => -abs($amount),
            'is_change' => true,
            'label' => 'Rendu monnaie',
        ]);
    }

    public function refund(): static
    {
        return $this->state(fn (array $attributes): array => [
            'is_refund' => true,
            'amount' => -abs((float) $attributes['amount']),
            'amount_company_currency' => -abs((float) $attributes['amount']),
        ]);
    }

    public function card(): static
    {
        return $this->state(fn (): array => [
            'card_type' => 'credit',
            'card_brand' => $this->faker->randomElement(['Visa', 'Mastercard', 'CB']),
            'card_last4' => $this->faker->numerify('####'),
            'auth_code' => strtoupper($this->faker->bothify('??####')),
            'entry_mode' => 'contactless',
        ]);
    }
}
