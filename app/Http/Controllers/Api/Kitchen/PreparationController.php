<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Kitchen;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Kitchen\SendPreparationRequest;
use App\Models\Pos\Order;
use App\Services\Kitchen\PreparationService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The register's side of the kitchen conversation (spec 02 KDS-051…KDS-058).
 *
 * `changes` is the authoritative answer to "what has the kitchen not seen yet".
 * The client keeps its own copy for the offline badge, but the server's delta
 * wins — that is what stops two waiters double-firing a table.
 */
final class PreparationController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly PreparationService $preparation) {}

    /** `GET /api/pos/orders/{order}/preparation-changes` */
    public function changes(Request $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        return new JsonResponse($this->preparation->delta($order)->toArray());
    }

    /** `POST /api/pos/orders/{order}/preparation` — send to kitchen. */
    public function send(SendPreparationRequest $request, Order $order): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);
        $this->assertOwned($request, $order);

        try {
            $result = $this->preparation->send(
                order: $order,
                config: $config,
                courseIndex: $request->validated('course_index') === null ? null : (int) $request->validated('course_index'),
                deviceId: (int) $device->getKey(),
                expectedSnapshotVersion: $request->validated('snapshot_version') === null
                    ? null
                    : (int) $request->validated('snapshot_version'),
            );
        } catch (DomainException $e) {
            return new JsonResponse([
                'error' => ['code' => $e->getMessage(), 'message' => 'Order outdated — another device already fired it.'],
                'delta' => $this->preparation->delta($order)->toArray(),
            ], 409);
        }

        return new JsonResponse([
            'delta' => $result['delta']->toArray(),
            'prep_orders' => $result['prep_orders'],
            'print_jobs' => $result['print_jobs'],
            'snapshot_version' => $result['snapshot_version'],
        ]);
    }

    /**
     * `POST /api/pos/orders/{order}/preparation/mark-sent` — rebuild the
     * snapshot without printing (KDS-062).
     */
    public function markSent(Request $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        return new JsonResponse(['snapshot_version' => $this->preparation->markAllSent($order)]);
    }

    private function assertOwned(Request $request, Order $order): void
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $order->pos_config_id === (int) $config->getKey(), 404);
    }
}
