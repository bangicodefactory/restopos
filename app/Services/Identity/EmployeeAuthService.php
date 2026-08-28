<?php

declare(strict_types=1);

namespace App\Services\Identity;

use App\Enums\EmployeeRole;
use App\Models\Identity\Employee;
use App\Models\Identity\TillRole;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use App\Support\Auth\EmployeeAbilities;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Support\Collection;

/**
 * Employee identity at the till (spec 03 §2.3, §2.5 axis 2).
 *
 * PIN verification must work with the network unplugged, so the bootstrap
 * payload carries a **per-device verifier** for every employee:
 *
 * ```
 * device_secret = HMAC-SHA256(app_key, "restopos:device-secret:{device.uuid}")
 * pin_verifier  = HMAC-SHA256(device_secret, "pin:{employee_id}:{sha256(pin)}")
 * badge_verifier= HMAC-SHA256(device_secret, "badge:{employee_id}:{sha256(badge)}")
 * ```
 *
 * The server only ever knows `sha256(pin)` (`employees.pin_hash`), so the client
 * hashes the typed PIN once and then HMACs it — the plaintext PIN and the raw
 * badge code never leave the device, and a stolen bootstrap payload from device
 * A is useless on device B.
 *
 * A PIN is an **attribution** control, not an authorisation boundary: anything
 * with financial consequence is gated by an ability check re-run server-side on
 * ingest (spec §2.5).
 */
final readonly class EmployeeAuthService
{
    public function __construct(
        private Config $config,
        private DeviceTokenService $tokens,
    ) {}

    /**
     * The auth block shipped for one employee in the bootstrap payload.
     *
     * @return array{
     *     id: int, name: string, role: string, has_pin: bool,
     *     abilities: list<string>, pin_verifier: ?string, badge_verifier: ?string
     * }
     */
    public function verifierFor(Employee $employee, PosConfig $config, PosDevice $device): array
    {
        $secret = $this->tokens->deviceSecret($device);
        // The slug, not the enum: a custom role has to reach the till under its own name, or the
        // client's gate resolves it to whatever enum case it was flattened onto.
        $slug = $this->roleSlugFor($employee, $config);

        return [
            'id' => (int) $employee->getKey(),
            'name' => (string) $employee->name,
            'role' => $slug,
            'has_pin' => $employee->hasPin(),
            'abilities' => $this->abilitiesFor($slug, $config),
            'pin_verifier' => filled($employee->pin_hash)
                ? hash_hmac('sha256', 'pin:'.$employee->getKey().':'.$employee->pin_hash, $secret)
                : null,
            'badge_verifier' => filled($employee->barcode_hash)
                ? hash_hmac('sha256', 'badge:'.$employee->getKey().':'.$employee->barcode_hash, $secret)
                : null,
        ];
    }

    /**
     * @param  Collection<int, Employee>  $employees
     * @return list<array<string, mixed>>
     */
    public function verifiersFor(Collection $employees, PosConfig $config, PosDevice $device): array
    {
        return $employees
            ->map(fn (Employee $e): array => $this->verifierFor($e, $config, $device))
            ->values()
            ->all();
    }

    /**
     * The online PIN path (`POST /api/pos/employees/verify`). Constant-time,
     * and it never reveals whether the employee exists.
     */
    public function verifyPin(PosConfig $config, int $employeeId, string $pin): ?Employee
    {
        $employee = $this->candidates($config)->firstWhere('id', $employeeId);

        if (! $employee instanceof Employee || ! $employee->checkPin($pin)) {
            return null;
        }

        return $employee;
    }

    /** Badge/RFID login: the code is matched against `employees.barcode_hash`. */
    public function verifyBadge(PosConfig $config, string $badge): ?Employee
    {
        foreach ($this->candidates($config) as $employee) {
            if ($employee->checkBarcode($badge)) {
                return $employee;
            }
        }

        return null;
    }

    /** The resolved register role for this employee on this config. */
    public function roleFor(Employee $employee, PosConfig $config): EmployeeRole
    {
        if (! $employee->relationLoaded('posConfigs')) {
            $employee->load('posConfigs');
        }

        return $employee->roleFor($config);
    }

    /**
     * The same answer as `roleFor()`, as a slug that may name a custom role.
     *
     * `roleFor()` returns the enum and therefore cannot say "Shift lead". It is kept because the
     * bootstrap payload and several callers are typed on it, and because for the three system roles
     * the two agree exactly — this one just does not flatten a custom role onto the nearest enum
     * case, which is what made a custom role look like a cashier to every check.
     */
    public function roleSlugFor(Employee $employee, PosConfig $config): string
    {
        if (! $employee->relationLoaded('posConfigs')) {
            $employee->load('posConfigs');
        }

        return $employee->roleSlugFor($config);
    }

    /**
     * Role → ability list, in three tiers (BAN-451).
     *
     *  1. **The register's own override** (`pos_configs.role_abilities`) when it names this role.
     *     Per-register, and it wins over everything: "the closing manager on till 3 may void".
     *  2. **The venue's role** (`till_roles`), which is what the back office now edits.
     *  3. **`config/pos.php`**, the shipping default, reached only when the venue has no row for
     *     this slug at all — a fresh install before `TillRoleSeeder`, or a test fixture.
     *
     * The order of 2 and 3 matters more than it looks. A role row with an **empty** ability list
     * means "this role gets nothing", and falling through to the config there would hand every
     * ability back the moment an operator revoked the last one — the same null-versus-empty trap the
     * per-register override documents. So the fallback is on the row's *absence*, never on its
     * contents.
     *
     * Filtered through `EmployeeAbilities` on the way out: a stored ability the code no longer
     * checks would otherwise reach the client's own gate, which would then allow at the till what
     * the server refuses on sync.
     *
     * @return list<string>
     */
    public function abilitiesFor(EmployeeRole|string $role, ?PosConfig $config = null): array
    {
        $slug = $role instanceof EmployeeRole ? $role->value : $role;

        /** @var array<string, list<string>>|null $override */
        $override = is_array($config?->getAttribute('role_abilities'))
            ? $config->getAttribute('role_abilities')
            : null;

        if (isset($override[$slug])) {
            return EmployeeAbilities::only((array) $override[$slug]);
        }

        $stored = TillRole::query()
            ->where('slug', $slug)
            ->when($config !== null, fn ($query) => $query->where('company_id', $config->company_id))
            ->first();

        if ($stored !== null) {
            return $stored->grantedAbilities();
        }

        /** @var array<string, list<string>> $defaults */
        $defaults = (array) $this->config->get('pos.role_abilities', []);

        return EmployeeAbilities::only((array) ($defaults[$slug] ?? []));
    }

    /** Does an employee hold an ability on this config? Used by the ingest guard. */
    public function can(Employee $employee, PosConfig $config, string $ability): bool
    {
        return in_array($ability, $this->abilitiesFor($this->roleSlugFor($employee, $config), $config), true);
    }

    /** @return Collection<int, Employee> */
    public function candidates(PosConfig $config): Collection
    {
        /** @var Collection<int, Employee> $employees */
        $employees = Employee::posLoadScope($config)->with('posConfigs')->get();

        return $employees;
    }
}
