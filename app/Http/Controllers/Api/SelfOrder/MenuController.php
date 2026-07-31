<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\SelfOrder;

use App\Http\Controllers\Controller;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Http\Resources\Pos\BootstrapResource;
use App\Services\SelfOrder\SelfOrderContext;
use App\Services\SelfOrder\SelfOrderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * `GET /api/self-order/{configToken}/menu` (spec 01-schema §5.6).
 *
 * Narrower rows *and* narrower fields than the register profile: no costs, no
 * margins, no internal notes, no employees, no other table's QR identifier.
 */
final class MenuController extends Controller
{
    public function __construct(private readonly SelfOrderService $selfOrder) {}

    public function __invoke(Request $request): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        return BootstrapResource::make($this->selfOrder->menu($context))->response();
    }
}
