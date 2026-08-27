<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\ProductAttribute;
use App\Models\User;

/**
 * Who may define the options a menu offers (BOF-085, BAN-412).
 *
 * The same right as the rest of the register setup. Worth more than it sounds: an attribute line's
 * per-value supplement is verified by `LinePriceAuthority` and charged, so what is edited here is
 * the price a guest pays for "large".
 */
final class ProductAttributePolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, ProductAttribute $attribute): bool
    {
        return $this->sameCompany($user, $attribute->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_products');
    }

    public function update(User $user, ProductAttribute $attribute): bool
    {
        return $this->sameCompany($user, $attribute->company_id) && $this->userCan($user, 'catalog.manage_products');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether an attribute *can* go — products offering it, orders that recorded a choice — is the
     * controller's question, and the answer is usually "deactivate": past orders must keep saying
     * what was chosen.
     */
    public function delete(User $user, ProductAttribute $attribute): bool
    {
        return $this->update($user, $attribute);
    }
}
