<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Pos\PosPrinter;
use App\Models\User;

/**
 * Who may configure a kitchen printer (BOF-114, BAN-432).
 *
 * The tenancy boundary is already held by the global scope — a foreign printer 404s on the route
 * binding, and a create is filed against the acting company rather than anything posted. What this
 * adds is the *role* question, which nothing was asking: before BAN-432 the only write was `update`
 * and it was ungated, and adding create and delete widened that rather than introducing it.
 *
 * `sameCompany` is still checked on the instance methods. It is redundant against the scope today,
 * and stated anyway: a policy that relies on a caller having gone through route binding is a policy
 * that breaks the first time one does not.
 */
final class PrinterPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'pos.kitchen.view');
    }

    public function view(User $user, PosPrinter $printer): bool
    {
        return $this->sameCompany($user, $printer->company_id) && $this->userCan($user, 'pos.kitchen.view');
    }

    /** Adding a printer is a configuration change, not a service action. */
    public function create(User $user): bool
    {
        return $this->userCan($user, 'pos.kitchen.manage');
    }

    public function update(User $user, PosPrinter $printer): bool
    {
        return $this->view($user, $printer) && $this->userCan($user, 'pos.kitchen.manage');
    }

    /**
     * Deleting takes a station out of service, so it is the same right as configuring one.
     *
     * The *safety* question — whether work is still queued for it — is the controller's, not this
     * policy's: permission and consequence are different questions, and answering the second here
     * would make a manager look unauthorised when they are merely too early.
     */
    public function delete(User $user, PosPrinter $printer): bool
    {
        return $this->update($user, $printer);
    }
}
