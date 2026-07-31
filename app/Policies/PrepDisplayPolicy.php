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
        return $this->userCan($user, 'pos.kitchen.view');
    }

    public function view(User $user, PrepDisplay $display): bool
    {
        return $this->sameCompany($user, $display->company_id) && $this->userCan($user, 'pos.kitchen.view');
    }

    public function update(User $user, PrepDisplay $display): bool
    {
        return $this->view($user, $display) && $this->userCan($user, 'pos.kitchen.manage');
    }

    /** Recall hides a mistake, so it is manager-gated everywhere (KDS-009). */
    public function recall(User $user, PrepDisplay $display): bool
    {
        return $this->view($user, $display) && $this->isManager($user);
    }
}
