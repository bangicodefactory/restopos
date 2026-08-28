<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\Combo;
use App\Models\User;

/**
 * Back-office authorisation for set menus (BOF-088).
 *
 * `catalog.manage_products` rather than a slug of its own: a course is a piece of the catalogue, it
 * is built out of product variants, and attaching one to a menu changes what that product sells for.
 * Whoever may edit the product may build its menu.
 */
final class ComboPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, Combo $combo): bool
    {
        return $this->sameCompany($user, $combo->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_products');
    }

    public function update(User $user, Combo $combo): bool
    {
        return $this->sameCompany($user, $combo->company_id)
            && $this->userCan($user, 'catalog.manage_products');
    }

    public function delete(User $user, Combo $combo): bool
    {
        return $this->update($user, $combo);
    }
}
