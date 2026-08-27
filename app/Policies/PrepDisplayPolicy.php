<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Kitchen\PrepDisplay;
use App\Models\User;

/** Kitchen display configuration (spec 02 KDS-003). */
final class PrepDisplayPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'kitchen.view');
    }

    public function view(User $user, PrepDisplay $display): bool
    {
        return $this->sameCompany($user, $display->company_id) && $this->userCan($user, 'kitchen.view');
    }

    /** Adding a screen is configuration, the same right as changing one (BAN-435). */
    public function create(User $user): bool
    {
        return $this->userCan($user, 'kitchen.manage_displays');
    }

    public function update(User $user, PrepDisplay $display): bool
    {
        return $this->view($user, $display) && $this->userCan($user, 'kitchen.manage_displays');
    }

    /**
     * Removing a screen takes a station out of the kitchen.
     *
     * Whether the board is *clear* is the controller's question, not this one: refusing here would
     * tell a manager they are not allowed to do something they are merely too early to do.
     */
    public function delete(User $user, PrepDisplay $display): bool
    {
        return $this->update($user, $display);
    }

    /** Recall hides a mistake, so it is manager-gated everywhere (KDS-009). */
    public function recall(User $user, PrepDisplay $display): bool
    {
        return $this->view($user, $display) && $this->isManager($user);
    }
}
