<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Enums\OrderState;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Resources\Pos\OrderResource;
use App\Models\Pos\Order;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Ticket-screen reads (spec 01-schema §5.4).
 *
 * `index` returns only `{id, uuid, updated_at}` so the client can diff its cache
 * cheaply, then hydrates the handful of orders the cashier actually opened.
 */
final class OrderController extends Controller
{
    use ResolvesDeviceContext;

    /** `GET /api/pos/orders?state=&from=&to=&search=&cursor=&limit=` */
    public function index(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $request->validate([
            'state' => ['nullable', 'string'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'search' => ['nullable', 'string', 'max:120'],
            'cursor' => ['nullable', 'integer'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:200'],
        ]);

        $limit = (int) $request->query('limit', '50');

        $query = Order::query()
            ->where('pos_config_id', $config->getKey())
            ->when($request->query('state'), fn ($q, $state) => $q->where('state', $state))
            ->when($request->query('from'), fn ($q, $from) => $q->where('ordered_at', '>=', $from))
            ->when($request->query('to'), fn ($q, $to) => $q->where('ordered_at', '<=', $to))
            ->when($request->query('search'), function ($q, $search): void {
                $q->where(function ($inner) use ($search): void {
                    $inner->where('name', 'like', '%'.$search.'%')
                        ->orWhere('receipt_number', 'like', '%'.$search.'%')
                        ->orWhere('tracking_number', 'like', '%'.$search.'%')
                        ->orWhere('ticket_code', 'like', '%'.$search.'%');
                });
            })
            ->when($request->query('cursor'), fn ($q, $cursor) => $q->where('id', '<', (int) $cursor))
            ->orderByDesc('id');

        $total = (clone $query)->count();
        $rows = $query->limit($limit + 1)->get(['id', 'uuid', 'name', 'state', 'amount_total', 'updated_at']);

        $next = null;

        if ($rows->count() > $limit) {
            $rows = $rows->take($limit);
            $next = (int) $rows->last()->getKey();
        }

        return new JsonResponse([
            'records' => $rows->map(static fn (Order $o): array => [
                'id' => (int) $o->getKey(),
                'uuid' => (string) $o->uuid,
                'name' => $o->name,
                'state' => $o->state instanceof OrderState ? $o->state->value : (string) $o->state,
                'amount_total' => (string) $o->amount_total,
                'updated_at' => (string) $o->updated_at,
            ])->values()->all(),
            'next_cursor' => $next,
            'total' => $total,
        ]);
    }

    /** `GET /api/pos/orders/{order}` — the full graph, by uuid. */
    public function show(Request $request, Order $order): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $order->pos_config_id === (int) $config->getKey(), 404);

        $order->load(['lines', 'payments', 'courses']);

        return OrderResource::make($order)->response();
    }
}
