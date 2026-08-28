<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Models\Identity\TillRole;
use App\Support\Auth\EmployeeAbilities;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * One till role and the abilities it holds (BOF-118, BAN-451).
 *
 * ## The allow-list is the point
 *
 * Abilities are checked by code, so the set of them is fixed by code. An operator picks from
 * `EmployeeAbilities`; they cannot type one in. Without that, a typo — `order.void_paied` — saves
 * cleanly, appears granted in the matrix, and does nothing, while `ApprovalAuthority` would have
 * treated it as a real permission and spent a manager's PIN on it.
 *
 * ## Escalation
 *
 * Three abilities hand an employee, at the counter, authority the back office governs with a
 * permission of its own — `config.manage` most of all, which lets a till rewrite the register's
 * configuration. A back-office user who cannot edit a register must not be able to grant that at the
 * till and then use it, so granting one requires holding the matching axis-1 permission.
 *
 * That is the readable form of the ticket's "a user cannot grant themselves an ability they do not
 * hold". Read literally it cannot be satisfied at all: a back-office user holds no till abilities,
 * so nobody could grant anything. `EmployeeAbilities::grantRequires()` names the three that
 * genuinely cross the axes and says which permission each needs.
 */
final class TillRoleRequest extends FormRequest
{
    public function authorize(): bool
    {
        $role = $this->route('role');

        return $role instanceof TillRole
            ? $this->user()?->can('update', $role) === true
            : $this->user()?->can('create', TillRole::class) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $role = $this->route('role');
        $required = $role === null ? 'required' : 'sometimes';

        return [
            // The slug is what `employees.default_role` and the pivot store, and what the bootstrap
            // ships to the till. Constrained to what a URL and a JSON key can carry without quoting.
            'slug' => [$required, 'string', 'max:32', 'regex:/^[a-z][a-z0-9_]*$/', $this->slugIsFree()],
            'name' => [$required, 'string', 'max:64'],
            'abilities' => ['sometimes', 'array'],
            'abilities.*' => ['string', $this->abilityExists()],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertGrantsAreWithinOurAuthority($validator);
            $this->assertSystemRoleKeepsItsSlug($validator);
        });
    }

    /**
     * An ability that crosses into the back office needs the back-office permission.
     *
     * Checked against what is being *added*, not against the whole list: a user who may not grant
     * `config.manage` should still be able to rename a role that already holds it, or change its
     * other abilities, rather than being locked out of the row entirely.
     */
    private function assertGrantsAreWithinOurAuthority(Validator $validator): void
    {
        if (! $this->has('abilities')) {
            return;
        }

        $role = $this->route('role');
        $held = $role instanceof TillRole ? $role->grantedAbilities() : [];
        $user = $this->user();

        foreach (EmployeeAbilities::only((array) $this->input('abilities', [])) as $ability) {
            if (in_array($ability, $held, true)) {
                continue;
            }

            $needs = EmployeeAbilities::grantRequires($ability);

            if ($needs !== null && $user?->hasPermission($needs) !== true) {
                $validator->errors()->add(
                    'abilities',
                    'Granting “'.$ability.'” needs the “'.$needs.'” permission, which you do not hold.'
                        .' Someone with it can grant this.',
                );
            }
        }
    }

    /**
     * A system role keeps its slug.
     *
     * `employees.default_role` and `AccessLevel::toRole()` both name these three by slug, and
     * neither is a foreign key the database would defend. Renaming `manager` to `boss` would leave
     * every manager pointing at a role that no longer exists, and `abilitiesFor()` would fall
     * through to the shipping defaults — quietly restoring abilities the venue had revoked.
     *
     * The display name is free to change; it is the slug that is load-bearing.
     */
    private function assertSystemRoleKeepsItsSlug(Validator $validator): void
    {
        $role = $this->route('role');

        if (! $role instanceof TillRole || ! $role->is_system) {
            return;
        }

        if ($this->has('slug') && (string) $this->input('slug') !== (string) $role->slug) {
            $validator->errors()->add('slug', 'This role ships with the product and its identifier is referenced elsewhere. Rename it instead — the name is what staff see.');
        }
    }

    private function abilityExists(): callable
    {
        return static function (string $attribute, mixed $value, callable $fail): void {
            if (! EmployeeAbilities::exists((string) $value)) {
                $fail('“'.$value.'” is not an ability this system checks, so granting it would do nothing.');
            }
        };
    }

    private function slugIsFree(): callable
    {
        $role = $this->route('role');

        return static function (string $attribute, mixed $value, callable $fail) use ($role): void {
            // Through the scoped model: slugs are unique per company, and `Rule::unique` runs on the
            // query builder where `CompanyScope` cannot reach — it would refuse a slug another venue
            // happens to use.
            $taken = TillRole::query()
                ->where('slug', (string) $value)
                ->when($role instanceof TillRole, fn ($query) => $query->whereKeyNot($role->getKey()))
                ->exists();

            if ($taken) {
                $fail('This venue already has a role with that identifier.');
            }
        };
    }
}
