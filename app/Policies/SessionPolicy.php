<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosSession;
use App\Models\User;

/** Session administration, including the rescue-session reconciliation queue. */
final class SessionPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'pos.session.view');
    }

    public function view(User $user, PosSession $session): bool
    {
        return $this->sameCompany($user, $session->company_id) && $this->userCan($user, 'pos.session.view');
    }

    /** Closing someone else's session from the back-office is manager-only. */
    public function close(User $user, PosSession $session): bool
    {
        return $this->view($user, $session) && $this->isManager($user);
    }

    /** A rescue session must be reconciled by a manager before it can close. */
    public function reconcileRescue(User $user, PosSession $session): bool
    {
        return $this->close($user, $session) && (bool) $session->is_rescue;
    }

    public function export(User $user): bool
    {
        return $this->userCan($user, 'pos.accounting.export');
    }
}
