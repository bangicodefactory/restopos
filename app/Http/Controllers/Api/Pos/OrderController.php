<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Enums\OrderState;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Resources\Pos\OrderResource;
use App\Models\Pos\Order;
use Illuminate\Contracts\Database\Query\Builder as QueryBuilder;
use Illuminate\Database\Eloquent\Builder;
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
            // The till's own orders **and its trusted peers'**. Pinned to one config, a cashier on
            // the second register could not find the order the first register took (REG-293).
            ->whereIn('pos_config_id', $config->visibleConfigIds())
            ->when($request->query('state'), fn ($q, $state) => $q->where('state', $state))
            ->when($request->query('from'), fn ($q, $from) => $q->where('ordered_at', '>=', $from))
            ->when($request->query('to'), fn ($q, $to) => $q->where('ordered_at', '<=', $to))
            ->when($request->query('search'), fn ($q, $search) => $this->applySearch($q, (string) $search))
            ->orderByDesc('id');

        $cursor = $request->query('cursor');

        // Counted before the cursor narrows it: `total` describes the result set the cashier is
        // paging through, and one that shrank with every page would be useless as a page count.
        //
        // Skipped entirely on a cursor page. The count is the expensive half of this endpoint — with
        // a search term it runs three correlated subqueries over the whole match set — and it cannot
        // have changed since the first page, which is where the client took it from. Paying for it
        // again on every "load more" would be paying for an answer we already gave.
        $total = $cursor === null ? (clone $query)->count() : null;

        $rows = (clone $query)
            ->when($cursor, fn ($q, $c) => $q->where('id', '<', (int) $c))
            ->limit($limit + 1)
            ->get(['id', 'uuid', 'name', 'receipt_number', 'state', 'amount_total', 'ordered_at', 'updated_at']);

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
                'receipt_number' => (string) $o->receipt_number,
                'state' => $o->state instanceof OrderState ? $o->state->value : (string) $o->state,
                'amount_total' => (string) $o->amount_total,
                'ordered_at' => (string) $o->ordered_at,
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

        abort_unless(in_array((int) $order->pos_config_id, $config->visibleConfigIds(), true), 404);

        // `lines.attributeValues` eagerly: the ticket screen refunds from this payload, and the
        // refund copies the chosen attributes onto the new line. `refundedOrder` and
        // `splitFromOrder` are loaded for their uuids alone — the client links orders by uuid, and
        // resolving them lazily inside the resource would be two queries per order rendered.
        $order->load(['lines.attributeValues', 'payments', 'courses', 'refundedOrder', 'splitFromOrder']);

        return OrderResource::make($order)->response();
    }

    /**
     * What "search" means on the ticket screen (REG-292).
     *
     * The cashier is holding a receipt, an invoice, or a card slip, or is being told a name over the
     * counter — so all four have to hit. The related-table terms are `whereHas` rather than joins so
     * that an order with three payments cannot come back three times.
     *
     * @param  Builder<Order>  $query
     * @return Builder<Order>
     */
    private function applySearch(Builder $query, string $search): Builder
    {
        // Trimmed: a term of pure whitespace is not a search, and `LIKE '%   %'` would quietly
        // return every order whose name happens to contain a run of spaces.
        $search = trim($search);

        if ($search === '') {
            return $query;
        }

        $like = '%'.$search.'%';

        return $query->where(function (Builder $inner) use ($like): void {
            $inner->where('name', 'like', $like)
                ->orWhere('receipt_number', 'like', $like)
                ->orWhere('tracking_number', 'like', $like)
                ->orWhere('ticket_code', 'like', $like)
                ->orWhere('floating_order_name', 'like', $like)
                ->orWhereHas('invoice', fn (Builder $q): Builder => $q->where('number', 'like', $like))
                ->orWhereHas('customer', fn (Builder $q): Builder => $q->where(
                    fn (Builder $c): Builder => $c->where('name', 'like', $like)->orWhere('display_name', 'like', $like),
                ))
                ->orWhereHas('payments', fn (Builder $q): Builder => $q->where(
                    fn (Builder $p): QueryBuilder|Builder => $p->where('cardholder_name', 'like', $like)
                        ->orWhere('card_last4', 'like', $like)
                        ->orWhere('transaction_reference', 'like', $like),
                ));
        });
    }
}
