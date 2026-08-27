<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosConfig;
use App\Models\User;

/**
 * Back-office authorisation for registers (spec 03 §2.5, axis 1).
 *
 * Axis 1 is about *users* in the admin app. Axis 2 — what a cashier may do at
 * the till — is the employee ability set checked in `EmployeeAuthService` and
 * re-checked on ingest; the two never mix.
 */
final class PosConfigPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, PosConfig $config): bool
    {
        return $this->sameCompany($user, $config->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_configs');
    }

    public function update(User $user, PosConfig $config): bool
    {
        return $this->sameCompany($user, $config->company_id) && $this->userCan($user, 'backoffice.manage_configs');
    }

    public function delete(User $user, PosConfig $config): bool
    {
        return $this->update($user, $config);
    }

    /** Pairing a device is a manager-level act: it mints a long-lived token. */
    public function pairDevice(User $user, PosConfig $config): bool
    {
        return $this->sameCompany($user, $config->company_id) && $this->userCan($user, 'backoffice.manage_configs');
    }
}
