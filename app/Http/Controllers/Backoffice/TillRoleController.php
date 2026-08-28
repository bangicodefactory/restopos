<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\TillRoleRequest;
use App\Models\Identity\Employee;
use App\Models\Identity\TillRole;
use App\Models\Pos\PosConfig;
use App\Support\Auth\EmployeeAbilities;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * Authoring what a till employee may do (BOF-118, BAN-451).
 *
 * The ability matrix was rendered from `config/pos.php` and never written, so granting a cashier the
 * right to void was a code deploy. "The closing manager on till 3 may void, nobody else may" was not
 * expressible at all.
 *
 * Roles are rows now (`till_roles`), seeded from that same config so a venue's abilities do not
 * change on migration, and the per-register override that already existed still wins over them.
 *
 * ## Deleting
 *
 * Refused while any employee holds the role, on their own record or on a register, and refused
 * outright for the three the product ships with. `employees.default_role` is a slug rather than a
 * foreign key — kept that way so the bootstrap payload and every existing reader are unchanged — so
 * the database will not defend this, and an orphaned slug is worse than a broken link: `abilitiesFor()`
 * falls through to the shipping defaults, quietly restoring abilities the venue had revoked.
 */
final class TillRoleController extends Controller
{
    public function store(TillRoleRequest $request): RedirectResponse
    {
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a role.',
            ]);
        }

        $data = $request->validated();

        TillRole::query()->create([
            ...$data,
            'company_id' => $companyId,
            'abilities' => EmployeeAbilities::only((array) ($data['abilities'] ?? [])),
            // Only the seeder mints a system role. A role created here is the venue's own and stays
            // removable, whatever the request said.
            'is_system' => false,
        ]);

        return back()->with('success', 'Role added.');
    }

    public function update(TillRoleRequest $request, TillRole $role): RedirectResponse
    {
        $data = $request->validated();

        if (array_key_exists('abilities', $data)) {
            // Filtered again here, not only in the request. The rule refuses an unknown ability, and
            // this refuses one the rule let through because the code changed underneath it — the
            // stored list is what the till receives, and an ability nothing checks would reach the
            // client's own gate and allow at the counter what the server refuses on sync.
            $data['abilities'] = EmployeeAbilities::only((array) $data['abilities']);
        }

        $role->forceFill($data)->save();

        return back()->with('success', 'Role saved.');
    }

    public function destroy(TillRole $role): RedirectResponse
    {
        Gate::authorize('delete', $role);

        if ($role->is_system) {
            throw ValidationException::withMessages([
                'role' => 'This role ships with the product and cannot be removed. Staff records and'
                    .' register assignments both name it, and it is what a new employee starts on.'
                    .' Change what it may do instead.',
            ]);
        }

        $held = Employee::query()->where('default_role', $role->slug)->count();

        if ($held > 0) {
            throw ValidationException::withMessages([
                'role' => $held.' employee(s) hold this role. Move them to another one first —'
                    .' otherwise they would fall back to the abilities the product ships with,'
                    .' which is not what removing a role should mean.',
            ]);
        }

        $assigned = DB::table('pos_config_employee')
            ->where('role_slug', $role->slug)
            ->whereIn('pos_config_id', PosConfig::query()->select('id'))
            ->count();

        if ($assigned > 0) {
            throw ValidationException::withMessages([
                'role' => 'This role is assigned to '.$assigned.' employee(s) on a register. Change'
                    .' those assignments first.',
            ]);
        }

        $role->delete();

        return back()->with('success', 'Role removed.');
    }
}
