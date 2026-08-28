<?php

declare(strict_types=1);

namespace App\Services\Identity;

use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\DB;

/**
 * One customer record absorbs another (BOF-119).
 *
 * Duplicates are made at the till, not in the back office: the same regular is entered as "Marie
 * Dupont" on Tuesday and "M. Dupond" on Friday, and neither the cashier nor the customer notices.
 * They matter because two records split one history — the order count, the loyalty points and,
 * worst, **the account balance**.
 *
 * ## Why this is a service and not an `update`
 *
 * Eight tables carry a `customer_id`, and missing one does not fail: the row simply keeps pointing
 * at a record the operator believes is gone.
 *
 *  - `pos_orders`, `pos_invoices`, `pos_payments`, `payment_transactions`, `cash_movements`
 *  - `customer_account_moves` — the ledger, and the reason `account_balance` has to be recomputed
 *  - `loyalty_cards`
 *  - `customers.parent_id` — a company's child contacts and delivery addresses
 *
 * `pos_invoices.customer_id` and `customer_account_moves.customer_id` are `restrictOnDelete`, which
 * is the database saying the same thing: these two records are the ones you cannot lose.
 *
 * ## The balance is derived, and that is the whole difficulty
 *
 * `customers.account_balance` is a cache of `sum(customer_account_moves.amount)` — the invariant
 * `CustomerAccountLedgerTest` asserts. Moving the loser's moves onto the survivor without
 * recomputing leaves the survivor's cached balance describing only half its own ledger: a regular
 * who owed 40 € on the duplicate would owe nothing, and the venue would never know to ask.
 *
 * Recomputed from the moves rather than added, because addition would carry over any drift the cache
 * already had rather than correcting it.
 */
final class CustomerMerger
{
    /** Every table whose `customer_id` has to follow the record. */
    private const REASSIGNED = [
        'pos_orders',
        'pos_invoices',
        'pos_payments',
        'payment_transactions',
        'cash_movements',
        'customer_account_moves',
        'loyalty_cards',
    ];

    public function __construct(private readonly ConnectionInterface $connection) {}

    /**
     * Move everything from `$loser` onto `$survivor`, then archive the loser.
     *
     * The loser is archived rather than deleted. Two reasons, and the second is the one that
     * decides it: `pos_invoices` is `restrictOnDelete` so the row often cannot be removed at all,
     * and a merge performed by mistake needs something left to look at.
     */
    public function merge(Customer $survivor, Customer $loser): void
    {
        DB::transaction(function () use ($survivor, $loser): void {
            foreach (self::REASSIGNED as $table) {
                $this->connection->table($table)
                    ->where('customer_id', $loser->getKey())
                    ->update(['customer_id' => $survivor->getKey()]);
            }

            // Child contacts and delivery addresses follow their parent.
            $this->connection->table('customers')
                ->where('parent_id', $loser->getKey())
                ->update(['parent_id' => $survivor->getKey()]);

            $this->recount($survivor);

            $loser->forceFill([
                'active' => false,
                // The loser's own totals are now describing rows that are no longer theirs. Left
                // alone, an archived duplicate would still read as owing money.
                'account_balance' => '0',
                'loyalty_points_cache' => '0',
                'order_count' => 0,
                'note' => trim((string) $loser->note."\nMerged into #".$survivor->getKey().'.'),
            ])->save();
        });
    }

    /**
     * Restate the survivor's cached totals from the rows that now belong to it.
     *
     * All four are caches over tables this merge has just moved, so all four are wrong until this
     * runs — and each one is wrong in a way that looks plausible rather than broken.
     */
    public function recount(Customer $customer): void
    {
        $balance = (string) CustomerAccountMove::query()
            ->where('customer_id', $customer->getKey())
            ->sum('amount');

        $orders = Order::query()->where('customer_id', $customer->getKey());

        $customer->forceFill([
            'account_balance' => bcadd($balance, '0', 4),
            'order_count' => (clone $orders)->count(),
            'last_order_at' => (clone $orders)->max('ordered_at'),
            // `01-schema.md` defines this column as the sum of *active* cards, display only. An
            // expired card's points are not spendable, so counting them would show a regular a
            // balance the till would refuse.
            'loyalty_points_cache' => (string) $this->connection->table('loyalty_cards')
                ->where('customer_id', $customer->getKey())
                ->where('active', true)
                ->sum('points'),
        ])->save();
    }
}
