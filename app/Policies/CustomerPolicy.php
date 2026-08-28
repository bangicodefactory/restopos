<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Identity\Customer;
use App\Models\User;

/**
 * Back-office authorisation for the customer base (BOF-119).
 *
 * `backoffice.manage_customers` is a new seeded slug, held by `owner` and `manager`. None of the
 * existing abilities fits: a customer record is not the catalogue, not a register and not an
 * employee, and it holds two things that need a permission of their own — an account balance the
 * venue is owed, and personal data.
 *
 * Merging is separated from updating deliberately. Editing a phone number is reversible; merging is
 * not, and it moves every order, invoice, account move and loyalty card of one record onto another.
 */
final class CustomerPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.access');
    }

    public function view(User $user, Customer $customer): bool
    {
        return $this->sameCompany($user, $customer->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_customers');
    }

    public function update(User $user, Customer $customer): bool
    {
        return $this->sameCompany($user, $customer->company_id)
            && $this->userCan($user, 'backoffice.manage_customers');
    }

    public function delete(User $user, Customer $customer): bool
    {
        return $this->update($user, $customer);
    }

    /** One record absorbs another. Irreversible, and it moves money. */
    public function merge(User $user, Customer $customer): bool
    {
        return $this->update($user, $customer);
    }
}
