<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;
use App\Support\Pos\SettledOrder;

/**
 * A movement on a customer's running tab (REG-208, BOF-119).
 *
 * The spec is explicit that this is *not* an ERP receivable (§"Payment terms, partner
 * receivable/payable ledgers" — "Simple 'on account' balances per customer with a statement view;
 * no ageing/dunning"). So there are two kinds of movement and no more.
 *
 * There is deliberately no `reversal`. A charge is only ever booked for a *settled* order, and
 * {@see SettledOrder} forbids editing a settled order's payments — so a booked
 * charge can never need undoing. A sale that comes back does so as a refund order whose on-account
 * payment is negative, which lowers the tab through the ordinary charge path. Adding the case
 * "for later" would put a third value in the CHECK constraint that nothing can ever write.
 *
 * Sign convention, which everything downstream depends on: **positive means the customer owes the
 * house**. A charge is therefore positive and a settlement negative, and the balance is the plain
 * sum of the column. Storing settlements as positive "credits" and subtracting them elsewhere is
 * the version of this that eventually adds where it should subtract.
 */
enum CustomerAccountMoveType: string
{
    use HasEnumHelpers;

    /** An order settled on account. Raises the balance. */
    case Charge = 'charge';

    /** The customer paid down the tab. Lowers the balance. */
    case Settlement = 'settlement';

    public function label(): string
    {
        return match ($this) {
            self::Charge => 'Charged to account',
            self::Settlement => 'Account settled',
        };
    }

    /** Does this movement raise what the customer owes? */
    public function increasesBalance(): bool
    {
        return $this === self::Charge;
    }
}
