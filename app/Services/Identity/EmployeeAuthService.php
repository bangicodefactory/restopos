<?php

declare(strict_types=1);

namespace App\Services\Identity;

use App\Enums\EmployeeRole;
use App\Models\Identity\Employee;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
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
        $role = $this->roleFor($employee, $config);

        return [
            'id' => (int) $employee->getKey(),
            'name' => (string) $employee->name,
            'role' => $role->value,
            'has_pin' => $employee->hasPin(),
            'abilities' => $this->abilitiesFor($role, $config),
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
     * Role → ability list. `config/pos.php` holds the defaults; a config may
     * override them through its `role_abilities` JSON column when present.
     *
     * @return list<string>
     */
    public function abilitiesFor(EmployeeRole $role, ?PosConfig $config = null): array
    {
        /** @var array<string, list<string>> $defaults */
        $defaults = (array) $this->config->get('pos.role_abilities', []);

        /** @var array<string, list<string>>|null $override */
        $override = is_array($config?->getAttribute('role_abilities'))
            ? $config->getAttribute('role_abilities')
            : null;

        $abilities = $override[$role->value] ?? $defaults[$role->value] ?? [];

        return array_values(array_unique(array_map(strval(...), $abilities)));
    }

    /** Does an employee hold an ability on this config? Used by the ingest guard. */
    public function can(Employee $employee, PosConfig $config, string $ability): bool
    {
        return in_array($ability, $this->abilitiesFor($this->roleFor($employee, $config), $config), true);
    }

    /** @return Collection<int, Employee> */
    public function candidates(PosConfig $config): Collection
    {
        /** @var Collection<int, Employee> $employees */
        $employees = Employee::posLoadScope($config)->with('posConfigs')->get();

        return $employees;
    }
}
