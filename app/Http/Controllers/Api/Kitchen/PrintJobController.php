<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Kitchen;

use App\Enums\PrintJobState;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Jobs\RenderPreparationTicket;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The preparation print-job queue (spec 02 KDS-050…KDS-060).
 *
 * Printers are polled, not pushed: a LAN thermal printer behind a station's
 * agent cannot receive a websocket, and Chrome's private-network rules make
 * direct browser→printer calls unreliable. The agent claims jobs, prints them
 * and reports back; a failed job is retried without re-printing the ones that
 * already succeeded (KDS-060).
 */
final class PrintJobController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly ConnectionInterface $connection) {}

    /** `GET /api/kitchen/print-jobs?printer_id=&limit=` */
    public function index(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $jobs = $this->connection->table('preparation_print_jobs')
            ->where('pos_config_id', $config->getKey())
            ->where('state', PrintJobState::Queued->value)
            ->when($request->query('printer_id'), fn ($q, $id) => $q->where('pos_printer_id', (int) $id))
            ->orderBy('queued_at')
            ->limit((int) $request->query('limit', '20'))
            ->get();

        // Render lazily: a job queued during ingest has no text yet.
        foreach ($jobs as $job) {
            if ($job->rendered_text === null) {
                RenderPreparationTicket::dispatchSync((int) $job->id);
            }
        }

        $ids = $jobs->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        return new JsonResponse([
            'jobs' => $ids === [] ? [] : $this->connection->table('preparation_print_jobs')
                ->whereIn('id', $ids)
                ->orderBy('queued_at')
                ->get()
                ->map(static fn (object $j): array => (array) $j)
                ->all(),
            'server_time' => now()->toIso8601ZuluString('microsecond'),
        ]);
    }

    /** `POST /api/kitchen/print-jobs/{job}/ack` — printed or failed. */
    public function acknowledge(Request $request, int $job): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $request->validate([
            'state' => ['required', 'in:printed,failed,skipped'],
            'error' => ['nullable', 'string', 'max:255'],
        ]);

        $state = PrintJobState::from((string) $request->input('state'));

        $updated = $this->connection->table('preparation_print_jobs')
            ->where('id', $job)
            ->where('pos_config_id', $config->getKey())
            ->update([
                'state' => $state->value,
                'printed_at' => $state === PrintJobState::Printed ? now() : null,
                'last_error' => $request->input('error'),
                'updated_at' => now(),
            ]);

        abort_if($updated === 0, 404);

        return new JsonResponse(null, 204);
    }
}
