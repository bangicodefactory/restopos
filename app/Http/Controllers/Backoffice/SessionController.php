<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\SessionState;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosSession;
use App\Services\Pos\AccountingExportService;
use App\Services\Pos\SessionService;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Sessions/Index` and `Sessions/Show` (spec 02 BOF-140…BOF-159).
 *
 * The detail page reads the **frozen** summary tables, not the live orders: a
 * closed session must render identically forever, even after a later correction
 * to one of its orders.
 */
final class SessionController extends Controller
{
    public function __construct(
        private readonly ConnectionInterface $connection,
        private readonly SessionService $sessions,
        private readonly AccountingExportService $exports,
    ) {}

    public function index(Request $request): Response
    {
        Gate::authorize('viewAny', PosSession::class);

        $sessions = PosSession::query()
            ->when($request->query('config_id'), fn ($q, $c) => $q->where('pos_config_id', (int) $c))
            ->when($request->query('state'), fn ($q, $s) => $q->where('state', $s))
            ->when($request->boolean('rescue_only'), fn ($q) => $q->where('is_rescue', true))
            ->orderByDesc('id')
            ->paginate(50)
            ->withQueryString();

        return Inertia::render('Sessions/Index', [
            'sessions' => $sessions->through(static fn (PosSession $s): array => [
                'id' => (int) $s->getKey(),
                'uuid' => (string) $s->uuid,
                'name' => (string) $s->name,
                'pos_config_id' => (int) $s->pos_config_id,
                'state' => $s->state->value,
                'business_date' => $s->business_date,
                'opened_at' => $s->opened_at,
                'closed_at' => $s->closed_at,
                'order_count' => (int) $s->order_count,
                'order_amount_total' => (string) $s->order_amount_total,
                'cash_difference' => (string) $s->cash_difference,
                'is_rescue' => (bool) $s->is_rescue,
                'closing_forced' => (bool) $s->closing_forced,
            ]),
            'filters' => $request->only(['config_id', 'state', 'rescue_only']),
            'states' => array_map(static fn (SessionState $s): array => ['value' => $s->value, 'label' => $s->label()], SessionState::cases()),
        ]);
    }

    public function show(PosSession $session): Response
    {
        Gate::authorize('view', $session);

        return Inertia::render('Sessions/Show', [
            'session' => $session->attributesToArray(),
            'paymentTotals' => $this->connection->table('session_payment_totals')
                ->where('pos_session_id', $session->getKey())->get()->map(static fn ($r): array => (array) $r)->all(),
            'salesSummaries' => Inertia::defer(fn (): array => $this->connection->table('session_sales_summaries')
                ->where('pos_session_id', $session->getKey())->get()->map(static fn ($r): array => (array) $r)->all()),
            'taxSummaries' => Inertia::defer(fn (): array => $this->connection->table('session_tax_summaries')
                ->where('pos_session_id', $session->getKey())->get()->map(static fn ($r): array => (array) $r)->all()),
            'cashMovements' => Inertia::defer(fn (): array => $this->connection->table('cash_movements')
                ->where('pos_session_id', $session->getKey())->whereNull('deleted_at')->orderBy('moved_at')
                ->get()->map(static fn ($r): array => (array) $r)->all()),
            'closingData' => $session->state === SessionState::Closed ? null : $this->sessions->closingData($session)->toArray(),
            'can' => ['close' => Gate::allows('close', $session)],
        ]);
    }

    /** Force-close a session from the back-office (manager only). */
    public function close(Request $request, PosSession $session): RedirectResponse
    {
        Gate::authorize('close', $session);

        $this->sessions->close(
            session: $session,
            countedCash: $request->input('counted_cash'),
            userId: (int) $request->user()?->getKey(),
            notes: $request->input('notes'),
            managerApproved: true,
            force: true,
        );

        return back()->with('success', 'Session closed.');
    }

    /** Build an `accounting_exports` row for a date range (BOF-150…159). */
    public function export(Request $request): RedirectResponse
    {
        Gate::authorize('export', PosSession::class);

        $data = $request->validate([
            'period_start' => ['required', 'date'],
            'period_end' => ['required', 'date', 'after_or_equal:period_start'],
            'session_ids' => ['nullable', 'array'],
        ]);

        $this->exports->build(
            companyId: (int) ($request->user()?->getAttribute('company_id') ?? 1),
            periodStart: (string) $data['period_start'],
            periodEnd: (string) $data['period_end'],
            sessionIds: isset($data['session_ids']) ? array_map(intval(...), (array) $data['session_ids']) : null,
            userId: (int) $request->user()?->getKey(),
        );

        return back()->with('success', 'Accounting export generated.');
    }
}
