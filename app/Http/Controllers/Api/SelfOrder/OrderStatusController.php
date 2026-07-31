<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\SelfOrder;

use App\Http\Controllers\Controller;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Http\Resources\SelfOrder\SelfOrderStatusResource;
use App\Services\SelfOrder\SelfOrderContext;
use App\Services\SelfOrder\SelfOrderService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Order status polling and cancellation for the customer's phone
 * (spec 02 SLF-080…SLF-099).
 *
 * The order access token is the whole authorisation: knowing the token *is*
 * owning the order, which is exactly the property we want for an anonymous
 * customer with no account.
 */
final class OrderStatusController extends Controller
{
    public function __construct(private readonly SelfOrderService $selfOrder) {}

    /** `GET /api/self-order/{configToken}/orders/{orderUuid}` */
    public function show(Request $request, string $configToken, string $orderUuid): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        try {
            $order = $this->selfOrder->status($context, $orderUuid, $this->token($request));
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_order_token', 'message' => $e->getMessage()]], 403);
        }

        return SelfOrderStatusResource::make($order)->response();
    }

    /** `POST /api/self-order/{configToken}/orders/{orderUuid}/cancel` */
    public function cancel(Request $request, string $configToken, string $orderUuid): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        try {
            $order = $this->selfOrder->cancel($context, $orderUuid, $this->token($request));
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'cancel_refused', 'message' => $e->getMessage()]], 422);
        }

        return SelfOrderStatusResource::make($order)->response();
    }

    private function token(Request $request): string
    {
        return (string) ($request->header('X-Order-Token') ?? $request->query('order_token', '') ?? '');
    }
}
