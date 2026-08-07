<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Enums\CashMovementType;
use App\Exceptions\Pos\RegisterNotReady;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\CashMovementRequest;
use App\Http\Requests\Pos\CloseSessionRequest;
use App\Http\Requests\Pos\OpenSessionRequest;
use App\Http\Resources\Pos\SessionResource;
use App\Models\Identity\Employee;
use App\Models\Pos\CashMovement;
use App\Models\Pos\PosSession;
use App\Services\Identity\EmployeeAuthService;
use App\Services\Pos\AccountingExportService;
use App\Services\Pos\RegisterReadiness;
use App\Services\Pos\SessionService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;

/**
 * Session lifecycle and cash control from the register (spec 02 REG-001…039).
 *
 * The client only ever *queues an intent*: every state transition, every
 * expected-cash figure and the variance decision are the server's (spec 03 §3.7).
 */
final class SessionController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(
        private readonly SessionService $sessions,
        private readonly EmployeeAuthService $employees,
        private readonly AccountingExportService $exports,
        private readonly RegisterReadiness $readiness,
    ) {}

    /**
     * `GET /api/pos/sessions/current`
     *
     * Carries an `opening` block alongside the session: what the drawer should hold, and anything
     * standing between this register and a session (REG-002, REG-004). Both are answered *before*
     * the cashier counts, so a misconfigured register is refused on the screen that opens it rather
     * than at the payment screen hours later.
     */
    public function current(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $session = $config->currentSession()->first();

        return new JsonResponse([
            'session' => $session === null ? null : SessionResource::make($session)->resolve($request),
            'opening' => [
                'expected_float' => $this->sessions->expectedOpeningFloat($config),
                'problems' => $this->readiness->problems($config),
            ],
        ]);
    }

    /** `POST /api/pos/sessions` */
    public function store(OpenSessionRequest $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        try {
            $session = $this->sessions->open(
                config: $config,
                openingFloat: (string) ($request->validated('opening_float') ?? '0'),
                employeeId: $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
                notes: $request->validated('notes'),
                denominations: (array) ($request->validated('denominations') ?? []),
            );
        } catch (RegisterNotReady $e) {
            // Its own code, and the whole list: "not ready" is a back-office fix, unlike
            // `session_open_failed`, which the cashier resolves at the till by closing the session
            // that is already open. Caught before DomainException — it is one.
            return new JsonResponse([
                'error' => [
                    'code' => 'register_not_ready',
                    'message' => $e->getMessage(),
                    'problems' => $e->problems,
                ],
            ], 422);
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'session_open_failed', 'message' => $e->getMessage()]], 422);
        }

        return SessionResource::make($session)->response()->setStatusCode(201);
    }

    /** `POST /api/pos/sessions/{session}/opening-control` */
    public function confirmOpening(Request $request, PosSession $session): JsonResponse
    {
        $this->assertOwned($request, $session);

        $request->validate(['counted_float' => ['required', 'string'], 'employee_id' => ['nullable', 'integer']]);

        try {
            $session = $this->sessions->confirmOpeningControl(
                $session,
                (string) $request->input('counted_float'),
                $request->integer('employee_id') ?: null,
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_transition', 'message' => $e->getMessage()]], 422);
        }

        return SessionResource::make($session)->response();
    }

    /** `GET /api/pos/sessions/{session}/closing-data` */
    public function closingData(Request $request, PosSession $session): JsonResponse
    {
        $this->assertOwned($request, $session);

        return new JsonResponse($this->sessions->closingData($session)->toArray());
    }

    /** `POST /api/pos/sessions/{session}/close` */
    public function close(CloseSessionRequest $request, PosSession $session): JsonResponse
    {
        [, $config] = $this->deviceContext($request);
        $this->assertOwned($request, $session);

        // An over-variance close needs a manager, verified here rather than
        // trusted from the client (spec 03 §2.3).
        $managerApproved = false;
        $approvedByEmployeeId = null;
        $managerId = $request->validated('manager_employee_id');
        $managerPin = $request->validated('manager_pin');

        if ($managerId !== null && $managerPin !== null) {
            $manager = $this->employees->verifyPin($config, (int) $managerId, (string) $managerPin);
            if ($manager !== null && $this->employees->can($manager, $config, 'session.close.over_variance')) {
                $managerApproved = true;
                $approvedByEmployeeId = (int) $manager->getKey();
            }
        }

        try {
            $session = $this->sessions->close(
                session: $session,
                countedCash: $request->validated('counted_cash'),
                countedByMethod: array_map(strval(...), (array) ($request->validated('counted_by_method') ?? [])),
                denominations: (array) ($request->validated('denominations') ?? []),
                employeeId: $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
                notes: $request->validated('notes'),
                managerApproved: $managerApproved,
                force: (bool) ($request->validated('force') ?? false),
                approvedByEmployeeId: $approvedByEmployeeId,
            );
        } catch (DomainException $e) {
            return new JsonResponse([
                'error' => ['code' => 'session_close_refused', 'message' => $e->getMessage()],
                'closing_data' => $this->sessions->closingData($session)->toArray(),
            ], 422);
        }

        return SessionResource::make($session)->response();
    }

    /** `POST /api/pos/sessions/{session}/cash-movements` */
    public function cashMovement(CashMovementRequest $request, PosSession $session): JsonResponse
    {
        [$device] = $this->deviceContext($request);
        $this->assertOwned($request, $session);

        try {
            $movement = $this->sessions->cashMove(
                session: $session,
                type: CashMovementType::from((string) $request->validated('movement_type')),
                amount: (string) $request->validated('amount'),
                reason: $request->validated('reason'),
                employeeId: $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
                deviceId: (int) $device->getKey(),
                uuid: $request->validated('uuid'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'cash_move_refused', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse([
            'uuid' => (string) $movement->uuid,
            'id' => (int) $movement->getKey(),
            'movement_type' => (string) ($movement->movement_type?->value ?? $movement->movement_type),
            'amount' => (string) $movement->amount,
            'session' => SessionResource::make($session->refresh())->resolve($request),
        ], 201);
    }

    /**
     * `GET /api/pos/sessions/{session}/cash-movements` (REG-012).
     *
     * The movements that explain the drawer, for the closing pane. Read from the server rather than
     * from the till's own replica on purpose, and for the same reason the closing figures are
     * (REG-014): a cash movement can be entered on one register of a pair and deleted from the
     * other, so a list assembled locally would show a drawer nobody else agrees with.
     *
     * Deleted rows are excluded. `deleteCashMovement` soft-deletes and logs, so the record survives
     * for the audit trail — but a movement that has been withdrawn is not part of the explanation
     * of the cash in the drawer, and showing it would invite counting it twice.
     */
    public function cashMovements(Request $request, PosSession $session): JsonResponse
    {
        $this->assertOwned($request, $session);

        $movements = CashMovement::query()
            ->where('pos_session_id', $session->getKey())
            ->orderBy('moved_at')
            ->orderBy('id')
            ->get();

        // One lookup for the names rather than one per row, and scoped to this register's company.
        //
        // The scoping is not belt-and-braces. `CompanyScope` deliberately does not apply to device
        // requests — a till pulling its own catalogue is not a tenant question — so this query is
        // unscoped unless it says otherwise, and `employee_id` on a movement is a bare integer that
        // arrived from a client. `cashMove` now refuses a foreign one at the door, but rows written
        // before it did are still in the table, and a name is not this register's to show.
        $employees = Employee::query()
            ->where('company_id', $session->company_id)
            ->whereIn('id', $movements->pluck('employee_id')->filter()->unique()->all() ?: [0])
            ->pluck('name', 'id');

        return new JsonResponse([
            'movements' => $movements->map(static fn (CashMovement $movement): array => [
                'uuid' => (string) $movement->uuid,
                'movement_type' => (string) ($movement->movement_type?->value ?? $movement->movement_type),
                'amount' => (string) $movement->amount,
                'reason' => $movement->reason,
                'employee_id' => $movement->employee_id,
                'employee_name' => $movement->employee_id === null
                    ? null
                    : ($employees[$movement->employee_id] ?? null),
                'moved_at' => $movement->moved_at,
            ])->values()->all(),
        ]);
    }

    /**
     * `DELETE /api/pos/sessions/{session}/cash-movements/{movement}` (REG-011).
     *
     * Manager-gated **and identity-proven**: the acting employee's PIN is verified server-side and
     * they must hold `cash.in_out.delete`. An employee id alone is not proof — ids ship in the
     * bootstrap payload, so trusting a client-supplied id would let any cashier pass a manager's id.
     */
    public function destroyCashMovement(Request $request, PosSession $session, CashMovement $movement): JsonResponse
    {
        [, $config] = $this->deviceContext($request);
        $this->assertOwned($request, $session);

        abort_unless((int) $movement->pos_session_id === (int) $session->getKey(), 404);

        $employeeId = $request->input('employee_id');
        $pin = $request->input('pin');
        $employee = $employeeId !== null && $pin !== null
            ? $this->employees->verifyPin($config, (int) $employeeId, (string) $pin)
            : null;

        if ($employee === null || ! $this->employees->can($employee, $config, 'cash.in_out.delete')) {
            return new JsonResponse([
                'error' => ['code' => 'forbidden', 'message' => 'Deleting a cash movement requires a manager PIN and the cash.in_out.delete ability.'],
            ], 403);
        }

        $this->sessions->deleteCashMovement($movement);

        return new JsonResponse(['session' => SessionResource::make($session->refresh())->resolve($request)]);
    }

    /** `POST /api/pos/sessions/{session}/accounting-export` */
    public function accountingExport(Request $request, PosSession $session): JsonResponse
    {
        $this->assertOwned($request, $session);

        try {
            $export = $this->exports->build(
                companyId: (int) $session->company_id,
                periodStart: (string) $session->business_date,
                periodEnd: (string) $session->business_date,
                sessionIds: [(int) $session->getKey()],
            );
        } catch (DomainException $e) {
            // Re-exporting a session that has already been consumed is a normal thing for an
            // operator to try, not a server fault — 409 so the caller can say so (BAN-448).
            throw new ConflictHttpException($e->getMessage(), $e);
        }

        return new JsonResponse([
            'uuid' => (string) $export->uuid,
            'state' => (string) ($export->state?->value ?? $export->state),
            'total_sales' => (string) $export->total_sales,
            'total_tax' => (string) $export->total_tax,
            'total_payments' => (string) $export->total_payments,
            'total_rounding' => (string) $export->total_rounding,
            'imbalance_amount' => (string) $export->imbalance_amount,
        ], 201);
    }

    /** A device may only touch sessions on its own register. */
    private function assertOwned(Request $request, PosSession $session): void
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $session->pos_config_id === (int) $config->getKey(), 404);
    }
}
