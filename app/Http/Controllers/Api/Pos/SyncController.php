<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\SyncOrdersRequest;
use App\Services\Pos\OrderSyncService;
use Illuminate\Http\JsonResponse;

/**
 * `POST /api/pos/sync` (spec 03 §3.6).
 *
 * Always answers `200` when the envelope is well-formed; the per-order verdict
 * lives inside `results[]`. That is deliberate — a transport-level failure code
 * would make the client's outbox retry the whole batch including the orders that
 * succeeded.
 */
final class SyncController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly OrderSyncService $sync) {}

    public function __invoke(SyncOrdersRequest $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $idempotencyKey = $request->header('Idempotency-Key');

        $response = $this->sync->sync(
            config: $config,
            device: $device,
            // The envelope is validated; the ORM-style child commands are passed
            // through verbatim. `validated()` would silently drop every field the
            // rules do not name — including `variant_id` and `price_unit` — and
            // the ingest service, not the validator, is what decides which line
            // fields are meaningful.
            payload: [...$request->validated(), 'orders' => (array) $request->input('orders', [])],
            idempotencyKey: is_string($idempotencyKey) && $idempotencyKey !== '' ? $idempotencyKey : null,
        );

        return new JsonResponse($response);
    }
}
