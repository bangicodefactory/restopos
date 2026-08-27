<?php

declare(strict_types=1);

namespace App\Policies;

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\User;

/** Back-office order administration (spec 02 BOF-130…159). */
final class OrderPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'backoffice.view_reports');
    }

    public function view(User $user, Order $order): bool
    {
        return $this->sameCompany($user, $order->company_id) && $this->userCan($user, 'backoffice.view_reports');
    }

    /** Only a draft may be edited from the back-office; settled orders are audit records. */
    public function update(User $user, Order $order): bool
    {
        return $this->view($user, $order)
            && $order->state === OrderState::Draft
            && $this->userCan($user, 'pos.void_line');
    }

    /** Voiding a paid order is a manager act with a money consequence. */
    public function void(User $user, Order $order): bool
    {
        return $this->view($user, $order) && $this->isManager($user);
    }

    public function refund(User $user, Order $order): bool
    {
        return $this->view($user, $order) && $this->userCan($user, 'pos.refund');
    }
}
