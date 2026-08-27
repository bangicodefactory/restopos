<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pricing\Tax;
use App\Models\User;

/**
 * Who may change what a sale is taxed at (BOF-091, BAN-396).
 *
 * The most consequential configuration in the back office: a tax is on every line of every sale, on
 * a document with legal weight, and a wrong one is not visible on the receipt — the total simply
 * comes out different. Gated on the same right as the rest of the register's setup, and stated
 * separately from that setup so the two can diverge if a venue ever wants them to.
 */
final class TaxPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, Tax $tax): bool
    {
        return $this->sameCompany($user, $tax->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_taxes');
    }

    public function update(User $user, Tax $tax): bool
    {
        return $this->sameCompany($user, $tax->company_id) && $this->userCan($user, 'catalog.manage_taxes');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether a tax *can* go — products still carrying it, closed reports quoting it — is the
     * controller's question. A tax on a Z-report can never be deleted by anyone, and that is not a
     * permission problem.
     */
    public function delete(User $user, Tax $tax): bool
    {
        return $this->update($user, $tax);
    }
}
