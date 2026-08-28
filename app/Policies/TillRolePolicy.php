<?php

declare(strict_types=1);

namespace App\Policies;

use App\Http\Requests\Backoffice\TillRoleRequest;
use App\Models\Identity\TillRole;
use App\Models\User;

/**
 * Back-office authorisation for till roles (BOF-118).
 *
 * `backoffice.manage_employees`, the same permission that guards the staff records themselves. That
 * is not a convenience: a role *is* what an employee may do, so someone who can already promote a
 * cashier to manager can already grant every ability a manager holds. Requiring a second permission
 * to author the role would guard the back door while the front one stands open.
 *
 * What that permission does **not** carry is the three abilities that reach back into the back
 * office — `config.manage`, `report.margins`, `session.rescue.close`. Those are guarded per ability
 * in {@see TillRoleRequest}, because the escalation they enable is
 * about the ability rather than about the role holding it.
 */
final class TillRolePolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, TillRole $role): bool
    {
        return $this->sameCompany($user, $role->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_employees');
    }

    public function update(User $user, TillRole $role): bool
    {
        return $this->sameCompany($user, $role->company_id)
            && $this->userCan($user, 'backoffice.manage_employees');
    }

    public function delete(User $user, TillRole $role): bool
    {
        return $this->update($user, $role);
    }
}
