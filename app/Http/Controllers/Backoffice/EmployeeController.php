<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\EmployeeRole;
use App\Http\Controllers\Controller;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use App\Models\Pos\PosSession;
use App\Rules\StaffPin;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Employees/Index` (spec 02 BOF-120…BOF-129).
 *
 * PINs and badge codes are write-only: the list shows `has_pin`, never the hash,
 * and setting a PIN stores `sha256(pin)` — the same hash the per-device offline
 * verifiers are derived from (spec 03 §2.3).
 */
final class EmployeeController extends Controller
{
    public function index(): Response
    {
        Gate::authorize('viewAny', Employee::class);

        return Inertia::render('Employees/Index', [
            'employees' => Employee::query()->orderBy('name')->get()->map(static fn (Employee $e): array => [
                'id' => (int) $e->getKey(),
                'name' => (string) $e->name,
                'job_title' => $e->job_title,
                'default_role' => (string) ($e->default_role?->value ?? $e->default_role),
                'color' => (int) $e->color,
                'has_pin' => $e->hasPin(),
                'has_badge' => filled($e->barcode_hash),
                'user_id' => $e->user_id,
                'active' => (bool) $e->active,
            ])->values()->all(),
            'roles' => array_map(static fn (EmployeeRole $r): array => ['value' => $r->value, 'label' => $r->label()], EmployeeRole::cases()),
            'abilities' => config('pos.role_abilities'),
        ]);
    }

    /**
     * `POST /employees` — hire someone (BOF-120).
     *
     * The list was whatever the seeder produced: an operator could edit a member of staff and could
     * not add one, so onboarding a new starter meant a database write.
     */
    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', Employee::class);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a member of staff.',
            ]);
        }

        $data = $this->validated($request, $companyId, null, creating: true);

        Employee::query()->create([
            ...$data,
            'company_id' => $companyId,
        ]);

        return back()->with('success', 'Member of staff added.');
    }

    /**
     * `DELETE /employees/{employee}` — remove someone (BOF-120).
     *
     * Refused once they have rung anything up. `pos_orders.employee_id` and the session tables hold
     * the trail that answers "who sold this" and "who closed that drawer", so deleting the row would
     * either fail at the database or orphan the answer.
     *
     * Deactivating is the right move and is what the message says: the employee disappears from
     * every till's login list and every past sale keeps their name.
     */
    public function destroy(Employee $employee): RedirectResponse
    {
        Gate::authorize('delete', $employee);

        // Through the models, not the query builder. `CompanyScope` is an Eloquent scope and cannot
        // reach `$connection->table()` — TenantIsolationTest fails the build for exactly this, and
        // it caught this method while it was being written.
        $orders = Order::query()->where('employee_id', $employee->getKey())->count();

        if ($orders > 0) {
            throw ValidationException::withMessages([
                'employee' => 'This person has taken '.$orders.' order(s) and cannot be removed.'
                    .' Deactivate them instead — they disappear from the tills and the history stays intact.',
            ]);
        }

        $sessions = PosSession::query()
            ->where('opened_by_employee_id', $employee->getKey())
            ->orWhere('closed_by_employee_id', $employee->getKey())
            ->count();

        if ($sessions > 0) {
            throw ValidationException::withMessages([
                'employee' => 'This person has opened '.$sessions.' session(s) and cannot be removed.'
                    .' Deactivate them instead.',
            ]);
        }

        $employee->delete();

        return back()->with('success', 'Member of staff removed.');
    }

    public function update(Request $request, Employee $employee): RedirectResponse
    {
        // Probed on master with a user holding no roles at all: this returned 302, promoted a
        // cashier to manager and set the caller's own PIN — which is the till credential.
        Gate::authorize('update', $employee);

        $data = $this->validated(
            $request,
            (int) $employee->company_id,
            (int) $employee->getKey(),
            creating: false,
        );

        $employee->forceFill($data)->save();

        return back()->with('success', 'Employee saved.');
    }

    /**
     * One rule set for hiring and editing.
     *
     * On create the identity fields are required; on update everything is `sometimes`, so a save
     * from the editor cannot blank a field it did not render.
     *
     * PINs and badges are hashed here and never stored in the clear — the same sha256 the per-device
     * offline verifiers are derived from (spec 03 §2.3).
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, int $companyId, ?int $employeeId, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:120'],
            'job_title' => ['sometimes', 'nullable', 'string', 'max:80'],
            'default_role' => [$required, Rule::enum(EmployeeRole::class)],
            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'active' => ['sometimes', 'boolean'],
            // BOF-117 — `min:4|max:12` accepted `0000` and `1234` on the credential that authorises
            // a void, a price override and an over-variance close.
            'pin' => ['sometimes', 'nullable', 'string', new StaffPin($companyId, $employeeId)],
            'badge' => ['sometimes', 'nullable', 'string', 'max:64'],
        ]);

        if (array_key_exists('pin', $data)) {
            $data['pin_hash'] = $data['pin'] === null ? null : hash('sha256', (string) $data['pin']);
            unset($data['pin']);
        }

        if (array_key_exists('badge', $data)) {
            $data['barcode_hash'] = $data['badge'] === null ? null : hash('sha256', (string) $data['badge']);
            unset($data['badge']);
        }

        return $data;
    }
}
