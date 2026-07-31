<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Dashboard/Index` — registers, their session state and today's headline
 * numbers (spec 02 BOF-001…BOF-029).
 *
 * Rescue sessions get a red badge here: they exist because an order arrived
 * after its session closed, and they must be reconciled by a human.
 */
final class DashboardController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function __invoke(Request $request): Response
    {
        $configs = PosConfig::query()->where('active', true)->orderBy('name')->get();

        $today = now()->toDateString();

        return Inertia::render('Dashboard/Index', [
            'registers' => $configs->map(function (PosConfig $config): array {
                $session = $config->currentSession()->first();

                return [
                    'id' => (int) $config->getKey(),
                    'name' => (string) $config->name,
                    'is_restaurant' => (bool) $config->is_restaurant,
                    'self_ordering_mode' => $config->self_ordering_mode->value,
                    'session' => $session === null ? null : [
                        'id' => (int) $session->getKey(),
                        'name' => (string) $session->name,
                        'state' => $session->state->value,
                        'opened_at' => $session->opened_at,
                        'order_count' => (int) $session->order_count,
                        'order_amount_total' => (string) $session->order_amount_total,
                    ],
                    'device_count' => $config->devices()->where('active', true)->count(),
                ];
            })->values()->all(),

            'today' => Inertia::defer(fn (): array => [
                'order_count' => $this->connection->table('pos_orders')
                    ->whereDate('ordered_at', $today)
                    ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
                    ->count(),
                'revenue' => (string) ($this->connection->table('pos_orders')
                    ->whereDate('ordered_at', $today)
                    ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value])
                    ->sum('amount_total') ?? '0'),
                'open_sessions' => $this->connection->table('pos_sessions')
                    ->where('state', '!=', SessionState::Closed->value)
                    ->count(),
            ]),

            'rescueSessions' => Inertia::defer(fn (): array => $this->connection->table('pos_sessions')
                ->where('is_rescue', true)
                ->where('state', '!=', SessionState::Closed->value)
                ->orderByDesc('id')
                ->get(['id', 'name', 'pos_config_id', 'opened_at', 'opening_notes', 'order_count'])
                ->map(static fn (object $s): array => (array) $s)
                ->all()),
        ]);
    }
}
