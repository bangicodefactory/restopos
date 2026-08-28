<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosPreset;
use App\Models\User;

/**
 * Back-office authorisation for service modes (BOF-113).
 *
 * A preset carries a pricelist and a fiscal position, so editing one changes both what a venue
 * charges and which tax it charges — the same weight as editing the register itself. That is why
 * this reads `backoffice.manage_configs` rather than a catalogue ability: a preset *is* register
 * configuration, and `PosConfigPolicy` guards the register with the same slug.
 */
final class PosPresetPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, PosPreset $preset): bool
    {
        return $this->sameCompany($user, $preset->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_configs');
    }

    public function update(User $user, PosPreset $preset): bool
    {
        return $this->sameCompany($user, $preset->company_id)
            && $this->userCan($user, 'backoffice.manage_configs');
    }

    public function delete(User $user, PosPreset $preset): bool
    {
        return $this->update($user, $preset);
    }
}
