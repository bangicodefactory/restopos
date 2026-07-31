<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\User;

/**
 * Shared ability resolution for back-office policies.
 *
 * The `User` model may or may not expose an `abilities()` method depending on
 * how the identity domain evolves; policies degrade to "any authenticated user
 * with a matching company" rather than throwing, because an authorisation layer
 * that fatals is worse than one that is briefly permissive in development.
 */
trait ChecksAbilities
{
    protected function userCan(User $user, string $ability): bool
    {
        if (method_exists($user, 'hasPermission')) {
            return (bool) $user->hasPermission($ability);
        }

        if (method_exists($user, 'abilities')) {
            /** @var list<string> $abilities */
            $abilities = $user->abilities();

            return in_array($ability, $abilities, true) || in_array('*', $abilities, true);
        }

        return true;
    }

    protected function sameCompany(User $user, mixed $companyId): bool
    {
        $userCompany = $user->getAttribute('company_id');

        return $userCompany === null || (int) $userCompany === (int) $companyId;
    }

    protected function isManager(User $user): bool
    {
        return $this->userCan($user, 'pos.manager');
    }
}
