<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\User;

/**
 * Shared ability resolution for back-office policies.
 *
 * Axis 1 is about *users* in the admin app. Axis 2 — what a cashier may do at the till — is the
 * employee ability set checked in `EmployeeAuthService` and re-checked on ingest; the two never mix.
 * Borrowing an axis-2 name for an axis-1 check is how this trait spent its whole life denying every
 * real user: `config.manage` is a till ability from the API contract, and `RoleSeeder` — the only
 * thing that creates `permissions` rows — has never seeded it.
 *
 * So every slug passed to `userCan` must be one `RoleSeeder::PERMISSIONS` actually seeds.
 * `hasPermission` is an exact string match, which makes an unseeded slug a permanent denial rather
 * than a strict check. `PolicyAbilityTest` fails the build if a policy invents one.
 */
trait ChecksAbilities
{
    protected function userCan(User $user, string $ability): bool
    {
        return $user->hasPermission($ability);
    }

    protected function sameCompany(User $user, mixed $companyId): bool
    {
        $userCompany = $user->getAttribute('company_id');

        return $userCompany === null || (int) $userCompany === (int) $companyId;
    }

    /**
     * Manager authority in the admin app, for acts no single permission names — voiding a paid
     * order, closing someone else's session, resetting a preparation display.
     *
     * A role check rather than an ability check, because that is what it is. It previously asked for
     * `pos.manager`, a permission that has never existed in any seed, so every one of those acts was
     * refused to everybody but a super-admin.
     */
    protected function isManager(User $user): bool
    {
        if ($user->is_super_admin) {
            return true;
        }

        return $user->roles->contains(
            static fn ($role): bool => in_array($role->slug, ['owner', 'manager'], true),
        );
    }
}
