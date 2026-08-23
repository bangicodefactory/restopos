<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\ProductCategory;
use App\Models\User;

/**
 * Who may change the accounting category tree (BAN-501).
 *
 * The same right as the rest of the register setup, and arguably it deserves more: `ledger_code` is
 * the revenue account every sales row in the accounting export is labelled with, so an edit here
 * changes what the venue's books say a sale was.
 */
final class ProductCategoryPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, ProductCategory $category): bool
    {
        return $this->sameCompany($user, $category->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, ProductCategory $category): bool
    {
        return $this->sameCompany($user, $category->company_id) && $this->userCan($user, 'config.manage');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether a category *can* go — sub-categories, products filed under it — is the controller's
     * question. `products.product_category_id` is `nullOnDelete`, so nothing stops the delete: it
     * blanks the revenue account on every one of those products instead, silently.
     */
    public function delete(User $user, ProductCategory $category): bool
    {
        return $this->update($user, $category);
    }
}
