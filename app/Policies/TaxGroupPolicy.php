<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pricing\TaxGroup;
use App\Models\User;

/**
 * Who may change how taxes are grouped on a receipt and a report (BOF-091, BAN-396).
 *
 * The same right as the taxes themselves. A group is the heading a tax totals under on the customer's
 * receipt and on the session's tax summary, so regrouping changes what a day's takings are read
 * against even though no rate moves.
 */
final class TaxGroupPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, TaxGroup $group): bool
    {
        return $this->sameCompany($user, $group->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, TaxGroup $group): bool
    {
        return $this->sameCompany($user, $group->company_id) && $this->userCan($user, 'config.manage');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether a group *can* go — taxes still filed under it, closed reports quoting it — is the
     * controller's question, not a permission one.
     */
    public function delete(User $user, TaxGroup $group): bool
    {
        return $this->update($user, $group);
    }
}
