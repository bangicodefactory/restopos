<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pricing\Pricelist;
use App\Models\User;

/**
 * Back-office authorisation for price rules (BOF-070…BOF-079).
 *
 * `PricelistController` had none, so any authenticated user could rename a pricelist, change its
 * currency or deactivate it — and a register's default pricelist decides every price it quotes. A
 * currency change on a pricelist is the same defect BAN-466 guards against on the register side,
 * reachable here without any permission at all.
 *
 * `catalog.manage_pricelists` is a real seeded slug held by `manager` and `owner`.
 */
final class PricelistPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, Pricelist $pricelist): bool
    {
        return $this->sameCompany($user, $pricelist->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_pricelists');
    }

    public function update(User $user, Pricelist $pricelist): bool
    {
        return $this->sameCompany($user, $pricelist->company_id)
            && $this->userCan($user, 'catalog.manage_pricelists');
    }

    public function delete(User $user, Pricelist $pricelist): bool
    {
        return $this->update($user, $pricelist);
    }
}
