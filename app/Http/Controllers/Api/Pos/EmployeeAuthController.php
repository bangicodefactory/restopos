<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\VerifyEmployeeRequest;
use App\Services\Identity\EmployeeAuthService;
use Illuminate\Http\JsonResponse;

/**
 * `POST /api/pos/employees/verify` — the online PIN/badge path (spec 03 §2.3).
 *
 * Offline verification happens client-side against the per-device verifiers in
 * the bootstrap payload. This endpoint is for the cases where a server-signed
 * answer is worth the round trip: manager approvals with real financial
 * consequence (void a paid order, close over variance, discount above limit).
 */
final class EmployeeAuthController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly EmployeeAuthService $employees) {}

    public function __invoke(VerifyEmployeeRequest $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $badge = $request->validated('badge');
        $pin = $request->validated('pin');
        $employeeId = $request->validated('employee_id');

        $employee = $badge !== null
            ? $this->employees->verifyBadge($config, (string) $badge)
            : ($employeeId === null || $pin === null
                ? null
                : $this->employees->verifyPin($config, (int) $employeeId, (string) $pin));

        if ($employee === null) {
            // Deliberately uniform: never reveal whether the employee exists.
            return new JsonResponse(['error' => ['code' => 'invalid_credentials', 'message' => 'PIN or badge not recognised.']], 422);
        }

        $role = $this->employees->roleFor($employee, $config);
        $abilities = $this->employees->abilitiesFor($role, $config);
        $ability = $request->validated('ability');

        return new JsonResponse([
            'employee' => [
                'id' => (int) $employee->getKey(),
                'name' => (string) $employee->name,
                'role' => $role->value,
                'abilities' => $abilities,
            ],
            'granted' => $ability === null || in_array((string) $ability, $abilities, true),
            'verified_at' => now()->toIso8601ZuluString('millisecond'),
        ]);
    }
}
