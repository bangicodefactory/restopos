<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\PosCategory;
use App\Models\User;

/**
 * Who may change the register's browsing tree (BOF-084, BAN-422).
 *
 * The controller sat behind `auth` alone until now, so any signed-in account — a cashier, a runner —
 * could restructure the menu every till in the venue browses. Gated on the same right as the rest of
 * the register setup.
 */
final class PosCategoryPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, PosCategory $category): bool
    {
        return $this->sameCompany($user, $category->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, PosCategory $category): bool
    {
        return $this->sameCompany($user, $category->company_id) && $this->userCan($user, 'config.manage');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether a category *can* go — sub-categories, products, printer routing pointing at it — is
     * the controller's question, and a far sharper one here than usual: every referent cascades.
     */
    public function delete(User $user, PosCategory $category): bool
    {
        return $this->update($user, $category);
    }
}
