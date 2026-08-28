<?php

declare(strict_types=1);

namespace App\Support\Auth;

/**
 * Every ability a till employee can hold — axis 2 (BOF-118, BAN-451).
 *
 * ## Which axis this is
 *
 * RestoPOS has two permission axes that must never be mixed. Axis 1 is back-office **users**:
 * `RoleSeeder::PERMISSIONS`, slugs like `backoffice.manage_employees`, checked by policies. Axis 2 —
 * this file — is till **employees**: what a cashier or a manager may do at the register, checked by
 * `EmployeeAuthService::can()` and by the client's own gate.
 *
 * A back-office user does not hold axis-2 abilities and an employee does not hold axis-1
 * permissions. `config.manage` below is an axis-2 ability despite its name.
 *
 * ## Why a registry and not just the roles
 *
 * Until BAN-451 the abilities *were* the config file: `ApprovalAuthority::catalogue()` took the
 * union of every configured role as "every ability this system defines", which was sound while only
 * a deploy could change that list.
 *
 * Once an operator can author a role, it stops being sound. A role granting `order.void_evrything`
 * — a typo, or a deliberate probe — would make that string a *real* ability by the union's
 * definition, and `ApprovalAuthority` would then accept an approval claiming it. The approval would
 * be recorded, the manager's PIN spent, and the till would proceed on a permission nothing checks.
 *
 * So the set of abilities is fixed here, in code, because it is code that checks them. An operator
 * chooses which of these a role holds; they cannot invent one.
 *
 * ## Keeping it honest
 *
 * `EmployeeAbilityRegistryTest` reads the seeded roles and the config defaults and fails if either
 * names an ability this file does not list. An ability the code checks but the registry omits is
 * invisible in the matrix and ungrantable; one the registry lists but nothing checks is a promise
 * the product does not keep.
 */
final class EmployeeAbilities
{
    /**
     * Ability => the group it is shown under.
     *
     * Groups are the operator's mental model of a shift, not the code's module layout: everything
     * about taking an order, everything about money, everything about the room.
     *
     * @var array<string, string>
     */
    private const ABILITIES = [
        // Taking and changing an order
        'order.create' => 'order',
        'order.line.add' => 'order',
        'order.delete_draft' => 'order',
        'order.void_paid' => 'order',

        // Money on a line
        'line.discount' => 'money',
        'line.discount.above_limit' => 'money',
        'line.price_override' => 'money',
        'refund.create' => 'money',

        // The drawer and the session
        'cash.in_out' => 'cash',
        'cash.in_out.delete' => 'cash',
        'cash.drawer.no_sale' => 'cash',
        'session.open' => 'cash',
        'session.close' => 'cash',
        'session.close.over_variance' => 'cash',
        'session.rescue.close' => 'cash',

        // Paper
        'receipt.print' => 'receipt',
        'receipt.reprint' => 'receipt',

        // The room
        'table.transfer' => 'room',
        'table.merge' => 'room',
        'table.unmerge' => 'room',
        'course.fire' => 'room',
        'bill.split' => 'room',

        // The pass
        'kitchen.send' => 'kitchen',
        'kitchen.recall' => 'kitchen',

        // What a manager may see and change from the till itself
        'report.margins' => 'admin',
        'config.manage' => 'admin',
    ];

    /**
     * Abilities the config grants that **no code checks** — found by `EmployeeAbilityRegistryTest`.
     *
     * These six have been in `config/pos.php` since it was written, and grepping every PHP and
     * TypeScript file in the repo finds them nowhere else. So a cashier granted `receipt.print` and
     * a cashier denied it can both print, and always could. They are advertised permissions that
     * change nothing.
     *
     * Listed rather than deleted, for two reasons. Deleting them would take rows out of a matrix
     * every venue has seen since the product shipped, which reads as a feature being removed. And
     * the honest fix is to *enforce* them — each one names a real action the register performs — so
     * removing the name would lose the record of which ones are owed.
     *
     * The matrix marks them. An operator who grants one should be told it does nothing yet, rather
     * than discovering it when a cashier prints a receipt they were not supposed to.
     *
     * @var list<string>
     */
    private const NOT_YET_ENFORCED = [
        'order.line.add',
        // The rescue *mechanism* exists — `pos_sessions.is_rescue`, the dashboard panel, the
        // back-office filter — and nothing checks this ability before performing one. It is still
        // listed in `GRANT_REQUIRES` below, because what it will govern when it is wired up is
        // closing over someone else's cash, and that guard should be in place before the check is.
        'session.rescue.close',
        'receipt.print',
        'table.merge',
        'course.fire',
        'kitchen.send',
        'kitchen.recall',
    ];

    /**
     * Abilities that may only be granted by a back-office user who holds the matching permission.
     *
     * The ticket asks for a guard that "a user cannot grant themselves an ability they do not hold",
     * and across two axes that cannot be read literally: a back-office user holds no till abilities
     * at all, so the literal rule would forbid granting anything.
     *
     * What it means in practice is this. Three of these abilities hand an employee, at the till,
     * authority that the back office governs with a permission of its own:
     *
     *  - **`config.manage`** lets a till change the register's own configuration. Someone who cannot
     *    edit a register in the back office must not be able to grant that power at the counter and
     *    then walk over to it.
     *  - **`report.margins`** shows cost and margin on the sales screen. That is the reporting
     *    permission, reached by another door.
     *  - **`session.rescue.close`** force-closes a session another device still holds — the recovery
     *    path for a till that has crashed, and a way to close over someone else's cash.
     *
     * The rest are ordinary shift permissions: whoever manages staff decides who may void or
     * discount, which is what `backoffice.manage_employees` already means.
     *
     * @var array<string, string> ability => the axis-1 permission required to grant it
     */
    private const GRANT_REQUIRES = [
        'config.manage' => 'backoffice.manage_configs',
        'report.margins' => 'backoffice.view_reports',
        'session.rescue.close' => 'backoffice.manage_configs',
    ];

    /** @return list<string> */
    public static function all(): array
    {
        return array_keys(self::ABILITIES);
    }

    public static function exists(string $ability): bool
    {
        return array_key_exists($ability, self::ABILITIES);
    }

    /**
     * Only the abilities this system understands, in registry order.
     *
     * Order matters for the matrix: the operator reads it top to bottom in the shape of a shift, and
     * `array_intersect` would preserve the caller's order instead.
     *
     * @param  iterable<mixed>  $abilities
     * @return list<string>
     */
    public static function only(iterable $abilities): array
    {
        $wanted = [];

        foreach ($abilities as $ability) {
            $wanted[(string) $ability] = true;
        }

        return array_values(array_filter(
            self::all(),
            static fn (string $ability): bool => isset($wanted[$ability]),
        ));
    }

    /** The axis-1 permission needed to grant this ability, or null when any staff manager may. */
    public static function grantRequires(string $ability): ?string
    {
        return self::GRANT_REQUIRES[$ability] ?? null;
    }

    /** Is this ability granted, shown, and checked by nothing? See {@see self::NOT_YET_ENFORCED}. */
    public static function isEnforced(string $ability): bool
    {
        return ! in_array($ability, self::NOT_YET_ENFORCED, true);
    }

    /** @return list<string> */
    public static function unenforced(): array
    {
        return self::NOT_YET_ENFORCED;
    }

    /**
     * The matrix, grouped.
     *
     * @return array<string, list<string>>
     */
    public static function grouped(): array
    {
        $groups = [];

        foreach (self::ABILITIES as $ability => $group) {
            $groups[$group][] = $ability;
        }

        return $groups;
    }
}
