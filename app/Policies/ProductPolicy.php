<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\Product;
use App\Models\User;

/**
 * Who may change the menu (BOF-081, BAN-407).
 *
 * The controller sat behind `auth` alone, so any signed-in account could reprice the catalogue every
 * till in the venue sells from. Gated on the same right as the rest of the register setup.
 */
final class ProductPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, Product $product): bool
    {
        return $this->sameCompany($user, $product->company_id) && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_products');
    }

    public function update(User $user, Product $product): bool
    {
        return $this->sameCompany($user, $product->company_id) && $this->userCan($user, 'catalog.manage_products');
    }

    /**
     * Archiving is the same right as creating.
     *
     * *Whether* a product can go is the controller's question, and the answer is never "erased":
     * every sold line holds `product_id` under `restrictOnDelete`, so the model soft-deletes and the
     * history stays readable.
     */
    public function delete(User $user, Product $product): bool
    {
        return $this->update($user, $product);
    }
}
