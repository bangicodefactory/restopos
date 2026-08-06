<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\OrderState;
use App\Enums\SessionState;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Query\Builder;
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

    /** Today's takeable orders for the acting company — the basis of both headline figures. */
    private function paidToday(string $today): Builder
    {
        $query = $this->connection->table('pos_orders')
            ->whereDate('ordered_at', $today)
            ->whereIn('state', [OrderState::Paid->value, OrderState::Done->value]);

        ActingCompany::scope($query);

        return $query;
    }

    /** Sessions still open for the acting company. */
    private function openSessions(): Builder
    {
        $query = $this->connection->table('pos_sessions')
            ->where('state', '!=', SessionState::Closed->value);

        ActingCompany::scope($query);

        return $query;
    }

    public function __invoke(Request $request): Response
    {
        $configs = PosConfig::query()->where('active', true)->orderBy('name')->get();

        $today = now()->toDateString();

        return Inertia::render('Dashboard/Index', [
            'registers' => $configs->map(function (PosConfig $config): array {
                $session = $config->currentSession()->first();

                return [
                    'id' => (int) $config->getKey(),
                    'uuid' => (string) $config->uuid,
                    'name' => (string) $config->name,
                    'is_restaurant' => (bool) $config->is_restaurant,
                    'self_ordering_mode' => $config->self_ordering_mode->value,
                    'session' => $session === null ? null : [
                        'id' => (int) $session->getKey(),
                        'uuid' => (string) $session->uuid,
                        'name' => $session->label(),
                        'state' => $session->state->value,
                        'opened_at' => $session->opened_at,
                        'order_count' => (int) $session->order_count,
                        'order_amount_total' => (string) $session->order_amount_total,
                    ],
                    'device_count' => $config->devices()->where('active', true)->count(),
                ];
            })->values()->all(),

            // These are query-builder calls, so `CompanyScope` never sees them — every one has to
            // say `ActingCompany::scope` itself. Unscoped, this panel put one tenant's daily
            // takings on every other tenant's home page (XCT-101).
            'today' => Inertia::defer(fn (): array => [
                'order_count' => $this->paidToday($today)->count(),
                'revenue' => (string) ($this->paidToday($today)->sum('amount_total') ?? '0'),
                'open_sessions' => $this->openSessions()->count(),
            ]),

            'rescueSessions' => Inertia::defer(fn (): array => $this->openSessions()
                ->where('is_rescue', true)
                ->orderByDesc('id')
                ->get(['id', 'uuid', 'name', 'pos_config_id', 'opened_at', 'opening_notes', 'order_count'])
                ->map(static fn (object $s): array => (array) $s)
                ->all()),
        ]);
    }
}
