<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PaymentMethod;
use App\Models\User;

/**
 * Who may change how money is taken (BOF-110, BAN-424).
 *
 * A payment method decides whether a tender counts into the drawer, whether change may be given and
 * which terminal the till talks to. Wrong, it does not fail loudly — the sale completes and the
 * drawer is short at close.
 */
final class PaymentMethodPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, PaymentMethod $method): bool
    {
        return $this->sameCompany($user, $method->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, PaymentMethod $method): bool
    {
        return $this->sameCompany($user, $method->company_id) && $this->userCan($user, 'config.manage');
    }

    /**
     * Deleting is the same right as creating.
     *
     * Whether a method *can* go — payments taken through it, reports quoting it, a session open on a
     * register that uses it — is the controller's question. None of those is a permission problem.
     */
    public function delete(User $user, PaymentMethod $method): bool
    {
        return $this->update($user, $method);
    }
}
