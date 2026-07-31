<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Enums\PrintJobState;
use App\Services\Kitchen\TicketRenderer;
use Illuminate\Contracts\Config\Repository as Config;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

/**
 * Renders a queued `preparation_print_jobs` row into printable text
 * (spec 02 KDS-053/KDS-055).
 *
 * Rendering is deliberately *not* done during ingest: a slow render must never
 * delay the sync response, and a printer that is down must not fail the sale.
 * The job only produces the payload — actual delivery is the printer agent's
 * job, which polls `GET /api/kitchen/print-jobs` and reports back.
 */
final class RenderPreparationTicket implements ShouldQueue
{
    use Queueable;

    public function __construct(private readonly int $printJobId) {}

    public function handle(ConnectionInterface $connection, TicketRenderer $renderer, Config $config): void
    {
        $job = $connection->table('preparation_print_jobs')->where('id', $this->printJobId)->first();

        if ($job === null || $job->state !== PrintJobState::Queued->value) {
            return;
        }

        try {
            /** @var array<string, mixed> $payload */
            $payload = json_decode((string) $job->payload, true) ?: [];

            $connection->table('preparation_print_jobs')->where('id', $this->printJobId)->update([
                'rendered_text' => $renderer->render($payload),
                'attempts' => (int) $job->attempts + 1,
                'updated_at' => now(),
            ]);
        } catch (Throwable $e) {
            $attempts = (int) $job->attempts + 1;
            $max = (int) $config->get('pos.kitchen.print_job_max_attempts', 5);

            $connection->table('preparation_print_jobs')->where('id', $this->printJobId)->update([
                'state' => $attempts >= $max ? PrintJobState::Failed->value : PrintJobState::Queued->value,
                'attempts' => $attempts,
                'last_error' => mb_substr($e->getMessage(), 0, 255),
                'updated_at' => now(),
            ]);
        }
    }
}
