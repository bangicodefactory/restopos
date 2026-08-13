<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\CustomerAccountMoveType;
use App\Enums\PaymentMethodType;
use App\Enums\PaymentStatus;
use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use App\Models\Pos\Payment as OrderPayment;
use App\Support\Pos\SettledOrder;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/**
 * The only writer of a customer's tab (REG-208, BOF-119).
 *
 * Three invariants, and everything here exists to hold them:
 *
 *  1. **`customers.account_balance` equals `sum(customer_account_moves.amount)`.** The column is a
 *     cache so a customer list can sort by what people owe without a join; the moves are the
 *     record. Both are written in one transaction under a row lock on the customer, because two
 *     tills settling the same regular at once would otherwise each read the old balance and the
 *     second `balance_after` would be a number that was never true.
 *
 *  2. **One move per payment.** `POST /api/pos/sync` is a pure upsert and the register retries on
 *     any network wobble, so the same pay-later payment arrives repeatedly by design. The unique
 *     index on `pos_payment_id` is the guard; {@see syncOrder()} checks first so an ordinary retry
 *     is a no-op rather than an exception, but the index is what holds under a race.
 *
 *  3. **Only settled sales reach a tab.** A cashier who taps "On account" and then changes their
 *     mind before validating must not leave a charge and a reversal on a document the customer
 *     reads. Since {@see SettledOrder} forbids editing a settled order's payments,
 *     charging only settled orders also means a booked charge can never need undoing — which is why
 *     there is no reversal here. A sale that comes back does so as a refund order, whose on-account
 *     payment is negative and lowers the tab through the same path.
 *
 * Deliberately *not* an ERP receivable — no ageing, no dunning, no payment terms. The spec draws
 * that line explicitly (02-features §"Payment terms, partner receivable/payable ledgers").
 */
final class CustomerAccountLedger
{
    /**
     * Book whatever this order owes the tab, once it is settled.
     *
     * Called after the order reaches its final state rather than from inside the payment loop, and
     * that placement is the point: the register may push the payments in one batch and the state
     * change in the next, and a hook on the payment command would then never fire for the batch
     * that settled the order. Sweeping the order instead is indifferent to how the commands were
     * split, and idempotent either way.
     */
    public function syncOrder(Order $order): void
    {
        if ($order->customer_id === null) {
            return;
        }

        if (! SettledOrder::isSettled($this->stateOf($order))) {
            return;
        }

        $payments = OrderPayment::query()
            ->where('pos_order_id', $order->getKey())
            ->where('is_change', false)
            ->where('payment_status', PaymentStatus::Done->value)
            ->whereHas('paymentMethod', static fn ($q) => $q->where(
                'method_type',
                PaymentMethodType::CustomerAccount->value,
            ))
            ->whereDoesntHave('accountMove')
            ->get();

        foreach ($payments as $payment) {
            $this->charge($order, $payment);
        }
    }

    /**
     * Take money against a tab.
     *
     * `$amount` is what the customer handed over — positive — and is booked negative, because
     * positive means owed. Overpaying is allowed and simply drives the balance below zero; the
     * house then owes them, which is a real state a regular can be in and not an error to reject.
     *
     * @param  array<string, mixed>  $attributes
     */
    public function settle(Customer $customer, string $amount, array $attributes = []): CustomerAccountMove
    {
        if (bccomp($amount, '0', 4) <= 0) {
            throw new InvalidArgumentException('A settlement must be a positive amount.');
        }

        return DB::transaction(fn (): CustomerAccountMove => $this->write(
            customerId: (int) $customer->getKey(),
            companyId: (int) $customer->company_id,
            type: CustomerAccountMoveType::Settlement,
            amount: bcmul($amount, '-1', 4),
            attributes: $attributes,
        ));
    }

    /** What this customer owes right now, read from the moves rather than from the cache. */
    public function balance(Customer $customer): string
    {
        $sum = (string) CustomerAccountMove::query()
            ->where('customer_id', $customer->getKey())
            ->sum('amount');

        return bcadd($sum, '0', 4);
    }

    /** Book one on-account payment. Skips a zero line, which is a cashier's abandoned keystroke. */
    private function charge(Order $order, OrderPayment $payment): void
    {
        if (bccomp((string) $payment->amount, '0', 4) === 0) {
            return;
        }

        DB::transaction(function () use ($order, $payment): void {
            /** @var Customer|null $customer */
            $customer = Customer::query()->whereKey($order->customer_id)->first();

            // Belt and braces over the company check the sync path already does. The ledger stamps
            // `company_id` on every row, and taking it from the payment — as this first did — meant
            // a cross-company `customer_id` produced a move filed under the *device's* company while
            // pointing at another company's customer: visible to the wrong tenant, invisible to the
            // one whose balance moved. Take it from the customer, and refuse when they disagree.
            if ($customer === null || (int) $customer->company_id !== (int) $payment->company_id) {
                return;
            }

            // Re-checked inside the transaction: the `whereDoesntHave` that selected this row ran
            // outside it, and two devices can push the same order at once.
            if (CustomerAccountMove::query()->where('pos_payment_id', $payment->getKey())->exists()) {
                return;
            }

            $this->write(
                customerId: (int) $customer->getKey(),
                companyId: (int) $customer->company_id,
                type: CustomerAccountMoveType::Charge,
                // Signed straight through: a refund order's payment is negative, so returning an
                // on-account sale lowers the tab without a second code path deciding the sign.
                amount: (string) $payment->amount,
                attributes: [
                    'pos_order_id' => $order->getKey(),
                    'pos_payment_id' => $payment->getKey(),
                    'pos_session_id' => $payment->pos_session_id,
                    'payment_method_id' => $payment->payment_method_id,
                    'employee_id' => $payment->employee_id,
                    'occurred_at' => $payment->paid_at ?? now(),
                ],
            );
        });
    }

    /**
     * Append one move and move the cache with it.
     *
     * The lock is on the customer row and is taken before the balance is read, so concurrent tills
     * serialise here rather than racing to write a `balance_after` that skips one of them.
     *
     * @param  array<string, mixed>  $attributes
     */
    private function write(
        int $customerId,
        int $companyId,
        CustomerAccountMoveType $type,
        string $amount,
        array $attributes = [],
    ): CustomerAccountMove {
        /** @var Customer $locked */
        $locked = Customer::query()->whereKey($customerId)->lockForUpdate()->firstOrFail();

        $balanceAfter = bcadd((string) $locked->account_balance, $amount, 4);

        /** @var CustomerAccountMove $move */
        $move = CustomerAccountMove::query()->create($attributes + [
            'company_id' => $companyId,
            'customer_id' => $customerId,
            'move_type' => $type->value,
            'amount' => $amount,
            'balance_after' => $balanceAfter,
            'occurred_at' => now(),
        ]);

        $locked->forceFill(['account_balance' => $balanceAfter])->save();

        return $move;
    }

    /** `state` is cast to an enum on the model but arrives as a string from a forceFill. */
    private function stateOf(Order $order): string
    {
        $state = $order->state;

        return is_string($state) ? $state : ($state?->value ?? '');
    }
}
