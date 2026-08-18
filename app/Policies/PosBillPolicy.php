<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosBill;
use App\Models\User;

/**
 * Who may set the coin and note denominations (BOF-111, BAN-483).
 *
 * Reference data a register reads on every boot, so changing it is a configuration act rather than a
 * service one — the same right as changing anything else on the register's setup.
 */
final class PosBillPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, PosBill $bill): bool
    {
        return $this->sameCompany($user, $bill->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, PosBill $bill): bool
    {
        return $this->sameCompany($user, $bill->company_id) && $this->userCan($user, 'config.manage');
    }

    public function delete(User $user, PosBill $bill): bool
    {
        return $this->update($user, $bill);
    }
}
