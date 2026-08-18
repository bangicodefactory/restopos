<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Restaurant\Floor;
use App\Models\User;

/**
 * Who may change the shape of the venue (BOF-116, BAN-439).
 *
 * Rooms are configuration, not service: a waiter rearranges tables from the register floor editor
 * (RST-030, gated there by `config.manage`), but adding or removing a whole dining room is a
 * back-office act. The abilities match the register's, so the same person can do both and nobody
 * else can do either.
 *
 * `sameCompany` is stated on the instance methods even though the global scope already 404s a
 * foreign floor on route binding. A policy that relies on its caller having gone through route
 * binding is a policy that breaks the first time one does not.
 */
final class FloorPolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'config.view');
    }

    public function view(User $user, Floor $floor): bool
    {
        return $this->sameCompany($user, $floor->company_id) && $this->userCan($user, 'config.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'config.manage');
    }

    public function update(User $user, Floor $floor): bool
    {
        return $this->sameCompany($user, $floor->company_id) && $this->userCan($user, 'config.manage');
    }

    /**
     * Deleting a room is the same right as creating one.
     *
     * Whether it is *safe* — open bills, tables still on it — is the controller's question. Refusing
     * here would tell a manager they are not allowed to do something they are allowed to do and
     * merely cannot do yet.
     */
    public function delete(User $user, Floor $floor): bool
    {
        return $this->update($user, $floor);
    }
}
