<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\EmployeeRole;
use App\Http\Controllers\Controller;
use App\Models\Identity\Employee;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
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

    public function update(Request $request, Employee $employee): RedirectResponse
    {
        // Probed on master with a user holding no roles at all: this returned 302, promoted a
        // cashier to manager and set the caller's own PIN — which is the till credential.
        Gate::authorize('update', $employee);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:120'],
            'job_title' => ['sometimes', 'nullable', 'string', 'max:80'],
            'default_role' => ['sometimes', Rule::enum(EmployeeRole::class)],
            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'active' => ['sometimes', 'boolean'],
            'pin' => ['sometimes', 'nullable', 'string', 'min:4', 'max:12'],
            'badge' => ['sometimes', 'nullable', 'string', 'max:64'],
        ]);

        // Never store a plaintext PIN or badge; only their sha256.
        if (array_key_exists('pin', $data)) {
            $data['pin_hash'] = $data['pin'] === null ? null : hash('sha256', (string) $data['pin']);
            unset($data['pin']);
        }

        if (array_key_exists('badge', $data)) {
            $data['barcode_hash'] = $data['badge'] === null ? null : hash('sha256', (string) $data['badge']);
            unset($data['badge']);
        }

        $employee->forceFill($data)->save();

        return back()->with('success', 'Employee saved.');
    }
}
