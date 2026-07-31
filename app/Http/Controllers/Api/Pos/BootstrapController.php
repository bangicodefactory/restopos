<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Resources\Pos\BootstrapResource;
use App\Services\Pos\BootstrapService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `GET /api/pos/bootstrap` and `GET /api/pos/bootstrap/manifest`
 * (spec 01-schema §5, spec 03 §3.2).
 *
 * The manifest exists so loading the POS is a progress bar with known
 * denominators instead of an opaque eight-second wait, and so a register that
 * re-opens five minutes later gets a `304` and skips straight to delta sync.
 */
final class BootstrapController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly BootstrapService $bootstrap) {}

    /** `GET /api/pos/bootstrap/manifest` */
    public function manifest(Request $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $etag = $this->bootstrap->etag($config);

        if ($this->matchesEtag($request, $etag)) {
            return (new JsonResponse(null, Response::HTTP_NOT_MODIFIED))->setEtag($etag, true);
        }

        return (new JsonResponse($this->bootstrap->manifest($config, $device)))->setEtag($etag, true);
    }

    /** `GET /api/pos/bootstrap?models=&since=&cursor=` */
    public function show(Request $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $etag = $this->bootstrap->etag($config);
        $since = $request->query('since');
        $cursor = $request->query('cursor');

        // ETag only short-circuits a *full* load; a delta always runs.
        if ($since === null && $cursor === null && $this->matchesEtag($request, $etag)) {
            return (new JsonResponse(null, Response::HTTP_NOT_MODIFIED))->setEtag($etag, true);
        }

        $models = $request->query('models');
        $only = is_string($models) && $models !== ''
            ? array_values(array_filter(array_map(trim(...), explode(',', $models))))
            : null;

        $payload = $this->bootstrap->payload(
            config: $config,
            device: $device,
            only: $only,
            since: is_string($since) && $since !== '' ? $since : null,
            cursor: is_string($cursor) && $cursor !== '' ? $cursor : null,
        );

        return BootstrapResource::make($payload)->response()->setEtag($etag, true);
    }

    private function matchesEtag(Request $request, string $etag): bool
    {
        $header = (string) $request->headers->get('If-None-Match', '');

        return $header !== '' && in_array($etag, array_map(trim(...), explode(',', str_replace('W/', '', $header))), true);
    }
}
