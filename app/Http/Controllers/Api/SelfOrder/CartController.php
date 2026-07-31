<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\SelfOrder;

use App\Http\Controllers\Controller;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Http\Requests\SelfOrder\SubmitCartRequest;
use App\Http\Resources\SelfOrder\SelfOrderStatusResource;
use App\Services\SelfOrder\SelfOrderContext;
use App\Services\SelfOrder\SelfOrderService;
use DomainException;
use Illuminate\Http\JsonResponse;

/**
 * `POST /api/self-order/{configToken}/orders` (spec 02 SLF-020…059, SLF-110).
 *
 * Append-to-table-order vs. new order is decided by the *config* (table service
 * + pay-after-meal appends), never by the client.
 */
final class CartController extends Controller
{
    public function __construct(private readonly SelfOrderService $selfOrder) {}

    public function __invoke(SubmitCartRequest $request): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        try {
            $result = $this->selfOrder->submitCart(
                context: $context,
                // Raw lines, not `validated()`: the validator would strip a
                // `price_unit` the cart had no business sending, and the tamper
                // detection in the service exists precisely to notice it.
                lines: (array) $request->input('lines', []),
                customerNote: $request->validated('customer_note'),
                customerEmail: $request->validated('customer_email'),
                customerPhone: $request->validated('customer_phone'),
                tableStandNumber: $request->validated('table_stand_number'),
                presetId: $request->validated('preset_id') === null ? null : (int) $request->validated('preset_id'),
                clientOrderUuid: $request->validated('order_uuid'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'cart_rejected', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse([
            'order' => SelfOrderStatusResource::make($result['order'])->resolve($request),
            'appended' => $result['appended'],
            'access_token' => $result['access_token'],
            'warnings' => $result['warnings'],
        ], 201);
    }
}
