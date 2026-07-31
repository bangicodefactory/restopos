<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\SelfOrder;

use App\Http\Controllers\Controller;
use App\Http\Middleware\ResolveSelfOrderContext;
use App\Services\Payment\NullProvider;
use App\Services\SelfOrder\SelfOrderContext;
use App\Services\SelfOrder\SelfOrderService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Online payment for self-order (spec 02 SLF-060…SLF-079).
 *
 * Both endpoints are stubs in the sense that the shipped `PaymentProvider` is
 * {@see NullProvider} — but the *flow* is real: intents
 * are recorded in `payment_transactions`, confirmation creates the
 * `pos_payments` row, totals are recomputed and `payment.status` is broadcast.
 * Swapping in a PSP is one container binding.
 */
final class PaymentController extends Controller
{
    public function __construct(private readonly SelfOrderService $selfOrder) {}

    /** `POST /api/self-order/{configToken}/orders/{orderUuid}/payment-intent` */
    public function intent(Request $request, string $configToken, string $orderUuid): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        $request->validate(['return_url' => ['nullable', 'url', 'max:512']]);

        try {
            $result = $this->selfOrder->createPaymentIntent(
                $context,
                $orderUuid,
                $this->token($request),
                $request->input('return_url'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'payment_intent_failed', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse($result, 201);
    }

    /** `POST /api/self-order/{configToken}/orders/{orderUuid}/payment-confirm` */
    public function confirm(Request $request, string $configToken, string $orderUuid): JsonResponse
    {
        /** @var SelfOrderContext $context */
        $context = $request->attributes->get(ResolveSelfOrderContext::ATTRIBUTE);

        $request->validate([
            'reference' => ['required', 'string', 'max:96'],
            'payload' => ['nullable', 'array'],
        ]);

        try {
            $result = $this->selfOrder->confirmPayment(
                $context,
                $orderUuid,
                $this->token($request),
                (string) $request->input('reference'),
                (array) $request->input('payload', []),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'payment_confirm_failed', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse($result);
    }

    private function token(Request $request): string
    {
        return (string) ($request->header('X-Order-Token') ?? $request->input('order_token', '') ?? '');
    }
}
