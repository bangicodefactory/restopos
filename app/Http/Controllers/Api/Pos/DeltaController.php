<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Resources\Pos\BootstrapResource;
use App\Services\Pos\DeltaService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `GET /api/pos/delta?since=&models=` and `GET /api/pos/open-orders?since=`
 * (spec 03 §3.5).
 */
final class DeltaController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly DeltaService $delta) {}

    public function index(Request $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $request->validate([
            'since' => ['required', 'date'],
            'models' => ['nullable', 'string'],
        ]);

        $models = $request->query('models');

        return BootstrapResource::make($this->delta->pull(
            config: $config,
            device: $device,
            since: (string) $request->query('since'),
            models: is_string($models) && $models !== ''
                ? array_values(array_filter(array_map(trim(...), explode(',', $models))))
                : null,
        ))->response();
    }

    /** Reconnect reconciliation — open orders plus the uuids that left the set. */
    public function openOrders(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $since = $request->query('since');

        return new JsonResponse($this->delta->openOrders(
            $config,
            is_string($since) && $since !== '' ? $since : null,
        ));
    }
}
