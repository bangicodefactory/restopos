<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\OrderState;
use App\Http\Controllers\Controller;
use App\Models\Pos\Order;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Orders/Index` and `Orders/Show` (spec 02 BOF-130…BOF-149).
 *
 * Settled orders are audit records, not editable documents: the detail page is
 * read-only apart from the manager-gated void and refund actions.
 */
final class OrderController extends Controller
{
    public function index(Request $request): Response
    {
        Gate::authorize('viewAny', Order::class);

        $request->validate([
            'search' => ['nullable', 'string', 'max:120'],
            'state' => ['nullable', 'string'],
            'config_id' => ['nullable', 'integer'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
        ]);

        $orders = Order::query()
            ->when($request->query('state'), fn ($q, $s) => $q->where('state', $s))
            ->when($request->query('config_id'), fn ($q, $c) => $q->where('pos_config_id', (int) $c))
            ->when($request->query('from'), fn ($q, $f) => $q->where('ordered_at', '>=', $f))
            ->when($request->query('to'), fn ($q, $t) => $q->where('ordered_at', '<=', $t))
            ->when($request->query('search'), fn ($q, $s) => $q->where(fn ($i) => $i
                ->where('name', 'like', '%'.$s.'%')
                ->orWhere('receipt_number', 'like', '%'.$s.'%')
                ->orWhere('tracking_number', 'like', '%'.$s.'%')))
            ->orderByDesc('ordered_at')
            ->paginate(50)
            ->withQueryString();

        return Inertia::render('Orders/Index', [
            'orders' => $orders->through(static fn (Order $o): array => [
                'id' => (int) $o->getKey(),
                'uuid' => (string) $o->uuid,
                'name' => $o->name,
                'receipt_number' => $o->receipt_number,
                'state' => $o->state instanceof OrderState ? $o->state->value : (string) $o->state,
                'source' => (string) ($o->source?->value ?? $o->source),
                'ordered_at' => $o->ordered_at,
                'amount_total' => (string) $o->amount_total,
                'pos_session_id' => (int) $o->pos_session_id,
                'is_refund' => (bool) $o->is_refund,
            ]),
            'filters' => $request->only(['search', 'state', 'config_id', 'from', 'to']),
            'states' => array_map(static fn (OrderState $s): array => ['value' => $s->value, 'label' => $s->label()], OrderState::cases()),
        ]);
    }

    public function show(Order $order): Response
    {
        Gate::authorize('view', $order);

        $order->load(['lines', 'payments', 'courses']);

        return Inertia::render('Orders/Show', [
            'order' => $order->attributesToArray(),
            'lines' => $order->lines->map(static fn ($l): array => $l->attributesToArray())->all(),
            'payments' => $order->payments->map(static fn ($p): array => $p->attributesToArray())->all(),
            'courses' => $order->courses->map(static fn ($c): array => $c->attributesToArray())->all(),
            'can' => [
                'void' => Gate::allows('void', $order),
                'refund' => Gate::allows('refund', $order),
            ],
        ]);
    }
}
