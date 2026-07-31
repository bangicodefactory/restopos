<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Kitchen;

use App\Enums\PrepLineState;
use App\Http\Controllers\Controller;
use App\Http\Middleware\AuthenticateDevice;
use App\Http\Requests\Kitchen\StageTransitionRequest;
use App\Http\Resources\Kitchen\PrepBoardResource;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\PosDevice;
use App\Services\Kitchen\KitchenDisplayService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The KDS API (spec 02 KDS-001…KDS-021).
 *
 * A display is a device: no personal login, a revocable token and no access to
 * money data. The board is also reachable by polling, because a kitchen that
 * silently misses orders is far worse than one that knows it is blind — the
 * websocket is an optimisation, never the contract.
 */
final class PrepDisplayController extends Controller
{
    public function __construct(private readonly KitchenDisplayService $displays) {}

    /** `GET /api/kitchen/{display}/orders?since=` */
    public function orders(Request $request, PrepDisplay $display): JsonResponse
    {
        $this->assertReachable($request, $display);

        $since = $request->query('since');

        return PrepBoardResource::make(
            $this->displays->board($display, is_string($since) && $since !== '' ? $since : null)
        )->response();
    }

    /** `GET /api/kitchen/{display}/stages` */
    public function stages(Request $request, PrepDisplay $display): JsonResponse
    {
        $this->assertReachable($request, $display);

        return new JsonResponse(['stages' => $this->displays->stages($display)]);
    }

    /** `POST /api/kitchen/{display}/orders/{prepOrder}/stage` — bump a card. */
    public function moveOrder(StageTransitionRequest $request, PrepDisplay $display, int $prepOrder): JsonResponse
    {
        $this->assertReachable($request, $display);

        try {
            $result = $this->displays->moveOrderToStage(
                $display,
                $prepOrder,
                (int) $request->validated('stage_id'),
                $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_stage', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse($result);
    }

    /** `POST /api/kitchen/{display}/lines/{line}/state` — per-item done. */
    public function moveLine(StageTransitionRequest $request, PrepDisplay $display, int $line): JsonResponse
    {
        $this->assertReachable($request, $display);

        $state = $request->validated('state');

        try {
            $result = $this->displays->setLineState(
                $display,
                $line,
                PrepLineState::from((string) ($state ?? PrepLineState::Ready->value)),
                $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_line', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse($result);
    }

    /** `POST /api/kitchen/{display}/orders/{prepOrder}/recall` */
    public function recall(Request $request, PrepDisplay $display, int $prepOrder): JsonResponse
    {
        $this->assertReachable($request, $display);

        return new JsonResponse($this->displays->recall(
            $display,
            $prepOrder,
            $request->integer('employee_id') ?: null,
        ));
    }

    /**
     * A display token may only address its own screen, and only screens wired
     * to the device's config.
     */
    private function assertReachable(Request $request, PrepDisplay $display): void
    {
        $device = $request->attributes->get(AuthenticateDevice::ATTRIBUTE);

        abort_unless($device instanceof PosDevice, 401);

        $linked = $display->newQuery()
            ->whereKey($display->getKey())
            ->whereHas('posConfigs', fn ($q) => $q->whereKey($device->pos_config_id))
            ->exists();

        abort_unless($linked, 404);
    }
}
