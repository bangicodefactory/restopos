<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Models\Identity\Company;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\FiscalPosition;

/**
 * Can this register trade at all? (REG-002.)
 *
 * A misconfigured register used to open happily and fail at the payment screen hours later, with a
 * drawer of cash and a queue of customers behind it. Every check here answers the same question:
 * *would this configuration break something the cashier cannot fix from the till?* Anything a
 * cashier can work around is not a problem, and is deliberately absent.
 *
 * The list is returned rather than thrown so the same three checks serve both callers: the open
 * endpoint refuses on a non-empty list, and `sessions/current` shows it before the drawer is even
 * counted. Telling someone at 07:55 that the register has no payment method is worth far more than
 * telling them at 12:30.
 */
final readonly class RegisterReadiness
{
    public const NoPaymentMethod = 'no_payment_method';

    public const CurrencyMismatch = 'currency_mismatch';

    public const FiscalPositionUnresolved = 'fiscal_position_unresolved';

    /**
     * Everything standing between this register and a session, in the order a manager would fix it.
     *
     * @return list<array{code: string, message: string}>
     */
    public function problems(PosConfig $config): array
    {
        return array_values(array_filter([
            $this->paymentMethod($config),
            $this->currency($config),
            $this->fiscalPosition($config),
        ]));
    }

    public function isReady(PosConfig $config): bool
    {
        return $this->problems($config) === [];
    }

    /**
     * At least one payment method the register can actually take money with.
     *
     * "Active" and "same company" both matter, and for different reasons: an archived method is
     * hidden from the payment screen, and a method belonging to another company would book this
     * venue's takings against that one's ledger. Either way the cashier reaches the payment screen
     * with nothing to press.
     *
     * @return array{code: string, message: string}|null
     */
    private function paymentMethod(PosConfig $config): ?array
    {
        $usable = $config->paymentMethods()
            ->where('payment_methods.active', true)
            ->where('payment_methods.company_id', $config->company_id)
            ->count();

        if ($usable > 0) {
            return null;
        }

        // Distinguish "none attached" from "attached but none usable" — the fix is a different
        // screen in the back office, and a manager reading this is standing at a till.
        $attached = $config->paymentMethods()->count();

        return [
            'code' => self::NoPaymentMethod,
            'message' => $attached === 0
                ? 'This register has no payment method. Add one in the back office before opening a session.'
                : "This register has {$attached} payment method(s), but none are active and owned by this company.",
        ];
    }

    /**
     * The register's currency must be the company's.
     *
     * Nothing downstream re-converts: the session, its orders and the accounting export all carry
     * the currency the register was configured with, so a mismatch does not fail loudly — it books
     * a day of trade at face value in the wrong unit, and the discrepancy surfaces at the bank.
     *
     * @return array{code: string, message: string}|null
     */
    private function currency(PosConfig $config): ?array
    {
        $companyCurrency = Company::query()->whereKey($config->company_id)->value('currency_id');

        if ($companyCurrency === null || (int) $companyCurrency === (int) $config->currency_id) {
            return null;
        }

        return [
            'code' => self::CurrencyMismatch,
            'message' => 'This register trades in a different currency from its company. Align them in the back office before opening a session.',
        ];
    }

    /**
     * A default fiscal position the client will actually receive.
     *
     * `FiscalPosition::posLoadScope` only replicates positions belonging to the register's company,
     * so a default pointing at another company's row is not merely a tenancy leak — the register
     * never receives it, and every order is priced against a tax mapping the till does not have. The
     * foreign key guarantees the row exists; it guarantees nothing about whose it is.
     *
     * Only checked when the register uses fiscal positions: with the feature off the column is
     * ignored everywhere else, and refusing to open over an unread column would be theatre.
     *
     * @return array{code: string, message: string}|null
     */
    private function fiscalPosition(PosConfig $config): ?array
    {
        if (! $config->use_fiscal_positions) {
            return null;
        }

        if ($config->default_fiscal_position_id === null) {
            // Fiscal positions are on but no default is set: the register falls back to the
            // product's own taxes, which is a legitimate setup. What is *not* legitimate is having
            // none at all to choose from, since the feature is then advertised and unusable.
            return $config->fiscalPositions()->where('fiscal_positions.company_id', $config->company_id)->exists()
                ? null
                : [
                    'code' => self::FiscalPositionUnresolved,
                    'message' => 'This register uses fiscal positions but none are available to it.',
                ];
        }

        $resolvable = FiscalPosition::query()
            ->whereKey($config->default_fiscal_position_id)
            ->where('company_id', $config->company_id)
            ->exists();

        return $resolvable ? null : [
            'code' => self::FiscalPositionUnresolved,
            'message' => 'The default fiscal position on this register belongs to another company and will not reach the till.',
        ];
    }
}
