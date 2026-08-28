<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Kitchen;

use App\Enums\PrintJobState;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Jobs\RenderPreparationTicket;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * The preparation print-job queue (spec 02 KDS-050…KDS-060, BAN-411).
 *
 * Printers are polled, not pushed: a LAN thermal printer behind a station's agent cannot receive a
 * websocket, and Chrome's private-network rules make direct browser→printer calls unreliable. The
 * agent claims jobs, prints them and reports back.
 *
 * **Claiming is the whole safety of it.** Until BAN-411 `index` handed every `queued` row to
 * whoever asked and wrote nothing back, and `PrintJobState::Printing` had no writer anywhere in the
 * codebase — the enum was already shaped for a lease nobody had written. Two agents on one config
 * would therefore print every ticket twice, and the only reason no venue has seen that is that this
 * queue has never had a consumer at all.
 *
 * A lease rather than a plain "mark it taken": an agent that is killed mid-job cannot release
 * anything, so the claim has to expire on its own, or that ticket is lost until somebody notices a
 * table never got its food.
 */
final class PrintJobController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(
        private readonly ConnectionInterface $connection,
        private readonly Config $config,
    ) {}

    /** `GET /api/kitchen/print-jobs?printer_id=&limit=` — claims, then returns what it claimed. */
    public function index(Request $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $limit = max(1, min(50, (int) $request->query('limit', '20')));
        $printerId = $request->query('printer_id');
        $leaseSeconds = (int) $this->config->get('pos.kitchen.print_lease_seconds', 90);

        $now = now();

        $candidates = $this->connection->table('preparation_print_jobs')
            ->where('pos_config_id', $config->getKey())
            ->where(fn ($query) => $this->claimable($query, $now))
            ->when($printerId, fn ($q, $id) => $q->where('pos_printer_id', (int) $id))
            ->orderBy('queued_at')
            ->limit($limit)
            ->get();

        $claimed = [];

        foreach ($candidates as $job) {
            if ($job->rendered_text === null) {
                // Not ready yet. Render off the request path — a slow render must not hold the
                // agent's poll open — and leave the row unclaimed, so the next poll picks it up
                // without having burnt a delivery attempt on a ticket that had no text to print.
                RenderPreparationTicket::dispatch((int) $job->id);

                continue;
            }

            // Compare-and-set, one row at a time, rather than a read followed by a bulk write.
            //
            // The read above is only a shortlist and may already be stale: another agent can claim
            // any of these between the select and the update. Re-stating the claimable condition
            // *inside* the update makes the database decide, and `affected === 1` is then proof
            // this caller won — not an assumption that the shortlist still holds.
            //
            // Deliberately not leaning on `lockForUpdate` for correctness: it is a no-op on the
            // SQLite the tests run against, so a lock-based claim would be untestable here and
            // would look right while proving nothing.
            $affected = $this->connection->table('preparation_print_jobs')
                ->where('id', $job->id)
                ->where(fn ($query) => $this->claimable($query, $now))
                ->update([
                    'state' => PrintJobState::Printing->value,
                    'leased_by' => (string) $device->uuid,
                    'leased_until' => $now->copy()->addSeconds($leaseSeconds),
                    'print_attempts' => $this->connection->raw('print_attempts + 1'),
                    'updated_at' => $now,
                ]);

            if ($affected === 1) {
                $claimed[] = (int) $job->id;
            }
        }

        return new JsonResponse([
            'jobs' => $claimed === [] ? [] : $this->connection->table('preparation_print_jobs')
                ->whereIn('id', $claimed)
                ->orderBy('queued_at')
                ->get()
                ->map(static fn (object $j): array => (array) $j)
                ->all(),
            'server_time' => now()->toIso8601ZuluString('microsecond'),
        ]);
    }

    /**
     * Free, or held by an agent that has stopped answering.
     *
     * Stated once and used twice — to shortlist, and again inside the claiming update. Two
     * spellings of this condition would be two chances for them to disagree, and the failure that
     * follows is the same ticket printed twice.
     *
     * @param  Builder  $query
     */
    private function claimable($query, Carbon $now): void
    {
        $query->where('state', PrintJobState::Queued->value)
            ->orWhere(function ($q) use ($now): void {
                // Reclaiming an expired lease is what makes a killed agent's ticket print exactly
                // once on restart rather than never.
                $q->where('state', PrintJobState::Printing->value)
                    ->where('leased_until', '<', $now);
            });
    }

    /** `POST /api/kitchen/print-jobs/{job}/ack` — printed, failed or skipped. */
    public function acknowledge(Request $request, int $job): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $request->validate([
            'state' => ['required', 'in:printed,failed,skipped'],
            'error' => ['nullable', 'string', 'max:255'],
        ]);

        $state = PrintJobState::from((string) $request->input('state'));
        $maxAttempts = (int) $this->config->get('pos.kitchen.print_delivery_max_attempts', 3);
        $error = $request->input('error');

        $status = $this->connection->transaction(function () use ($job, $config, $state, $error, $maxAttempts): string {
            $row = $this->connection->table('preparation_print_jobs')
                ->where('id', $job)
                ->where('pos_config_id', $config->getKey())
                ->lockForUpdate()
                ->first();

            if ($row === null) {
                return 'missing';
            }

            // A settled job stays settled. Without this a duplicate `failed` ack — a retrying agent
            // that had in fact printed, delivery being at-least-once — would reopen a ticket that is
            // already on the pass and print it again. The previous code went further: it nulled
            // `printed_at` on every non-printed ack, erasing the time a real print had happened.
            if (! PrintJobState::from((string) $row->state)->isPending()) {
                return 'settled';
            }

            $clearLease = ['leased_by' => null, 'leased_until' => null, 'updated_at' => now()];

            if ($state === PrintJobState::Printed) {
                $this->connection->table('preparation_print_jobs')->where('id', $job)->update([
                    ...$clearLease,
                    'state' => PrintJobState::Printed->value,
                    'printed_at' => now(),
                    'last_error' => null,
                ]);

                return 'ok';
            }

            if ($state === PrintJobState::Skipped) {
                $this->connection->table('preparation_print_jobs')->where('id', $job)->update([
                    ...$clearLease,
                    'state' => PrintJobState::Skipped->value,
                    'last_error' => $error,
                ]);

                return 'ok';
            }

            // Failed. Re-offer until the cap, then park it — visibly, with its last error, in the
            // back-office queue. Terminal-on-first-failure was the old behaviour, and it meant one
            // transient printer hiccup silently cost a kitchen ticket.
            $parked = (int) $row->print_attempts >= $maxAttempts;

            $this->connection->table('preparation_print_jobs')->where('id', $job)->update([
                ...$clearLease,
                'state' => $parked ? PrintJobState::Failed->value : PrintJobState::Queued->value,
                'last_error' => $error,
            ]);

            return $parked ? 'parked' : 'requeued';
        });

        abort_if($status === 'missing', 404);

        // 409 rather than 204: an agent acking a job it does not hold has lost track of what it
        // printed, and answering "fine" would hide that from whoever reads its logs.
        abort_if($status === 'settled', 409, 'This print job has already been settled.');

        return new JsonResponse(null, 204);
    }
}
