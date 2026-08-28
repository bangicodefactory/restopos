<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pricing\FiscalPosition;
use App\Models\User;

/**
 * Who may change which tax applies (BOF-036, BAN-398).
 *
 * `catalog.manage_taxes` — the same ability as the tax table itself, because a fiscal position is a
 * statement about taxes and not about the catalogue it happens to be applied to. Someone trusted to
 * set a VAT rate is the person trusted to say when a different one applies.
 *
 * Registered explicitly in `PosServiceProvider`: policy auto-discovery does not reach
 * `App\Models\Pricing`, and a policy nothing registers fails open.
 */
final class FiscalPositionPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, FiscalPosition $position): bool
    {
        return $this->sameCompany($user, $position->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_taxes');
    }

    public function update(User $user, FiscalPosition $position): bool
    {
        return $this->sameCompany($user, $position->company_id)
            && $this->userCan($user, 'catalog.manage_taxes');
    }

    public function delete(User $user, FiscalPosition $position): bool
    {
        return $this->update($user, $position);
    }
}
