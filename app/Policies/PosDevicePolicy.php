<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosDevice;
use App\Models\User;

/**
 * Back-office authorisation for paired devices (BOF-060…BOF-069).
 *
 * A device is owned through its register: `pos_devices` has a `pos_config_id` and **no
 * `company_id`**, so it carries no `BelongsToCompany` and gets no global scope. Ownership therefore
 * has to be asked of the config, which is what `sameCompany` is given here.
 *
 * That absence is also why `DeviceController::index` listed every tenant's devices — their names,
 * their user agents and when each was last seen. Revoking one is worse still: it bricks another
 * venue's till.
 *
 * `backoffice.manage_configs` rather than a device-specific slug, matching
 * {@see PosConfigPolicy::pairDevice()} — pairing and revoking are the same act of register
 * administration, and inventing a second vocabulary for it is how the ability names drifted before.
 */
final class PosDevicePolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, PosDevice $device): bool
    {
        return $this->ownsRegister($user, $device) && $this->userCan($user, 'backoffice.access');
    }

    public function update(User $user, PosDevice $device): bool
    {
        return $this->ownsRegister($user, $device) && $this->userCan($user, 'backoffice.manage_configs');
    }

    /** Revoking a device is what kills a till mid-service, so it is the manage-level check. */
    public function delete(User $user, PosDevice $device): bool
    {
        return $this->update($user, $device);
    }

    private function ownsRegister(User $user, PosDevice $device): bool
    {
        return $this->sameCompany($user, $device->posConfig?->company_id);
    }
}
