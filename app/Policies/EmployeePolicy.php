<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Identity\Employee;
use App\Models\User;

/**
 * Back-office authorisation for staff records (BOF-120…BOF-129).
 *
 * `EmployeeController` had none. Probed on master with a user holding no roles and no permissions at
 * all: `PATCH /employees/{id}` with `default_role=manager` and `pin=9999` returned 302, promoted a
 * cashier to manager, and set the attacker's own PIN on the record. That is not a back-office
 * permission problem — it is a walk-up escalation to manager authority *at the till*, because the
 * PIN is the till credential and the role is what the register checks before allowing a void, a
 * price override or an over-variance close.
 *
 * Guarded by `backoffice.manage_employees`, which `RoleSeeder` seeds and grants to `manager` and
 * `owner`. Asking for anything else would be a permanent denial — see {@see ChecksAbilities}.
 */
final class EmployeePolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, Employee $employee): bool
    {
        return $this->sameCompany($user, $employee->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_employees');
    }

    public function update(User $user, Employee $employee): bool
    {
        return $this->sameCompany($user, $employee->company_id)
            && $this->userCan($user, 'backoffice.manage_employees');
    }

    public function delete(User $user, Employee $employee): bool
    {
        return $this->update($user, $employee);
    }
}
