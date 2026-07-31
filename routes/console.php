<?php

declare(strict_types=1);

use App\Enums\PrintJobState;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function (): void {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

/**
 * Prune answered sync requests (spec 03 §3.6.3).
 *
 * `sync_requests` is an idempotency ledger, not an audit log: once the retry
 * window has passed, a replay is indistinguishable from a fresh request and the
 * rows are dead weight on the hottest table in the system.
 */
Artisan::command('pos:prune-sync-requests {--days=}', function (): void {
    $days = (int) ($this->option('days') ?? config('pos.sync.request_log_retention_days', 30));

    $deleted = DB::table('sync_requests')
        ->whereNotNull('processed_at')
        ->where('processed_at', '<', now()->subDays($days))
        ->delete();

    $this->info("Pruned {$deleted} sync request(s) older than {$days} day(s).");
})->purpose('Prune answered POS sync requests');

/**
 * Retire print jobs that no agent ever claimed. A queued ticket from yesterday
 * printing today is worse than not printing at all.
 */
Artisan::command('pos:expire-print-jobs {--hours=6}', function (): void {
    $hours = (int) $this->option('hours');

    $expired = DB::table('preparation_print_jobs')
        ->where('state', PrintJobState::Queued->value)
        ->where('queued_at', '<', now()->subHours($hours))
        ->update([
            'state' => PrintJobState::Skipped->value,
            'last_error' => "Expired after {$hours}h without being claimed by a printer agent.",
            'updated_at' => now(),
        ]);

    $this->info("Expired {$expired} stale print job(s).");
})->purpose('Expire unclaimed preparation print jobs');

/**
 * Surface rescue sessions that nobody has reconciled. They exist because an
 * order arrived after its session closed; leaving them open indefinitely means
 * revenue sitting outside any reported period.
 */
Artisan::command('pos:report-rescue-sessions', function (): void {
    $rows = DB::table('pos_sessions')
        ->where('is_rescue', true)
        ->where('state', '!=', 'closed')
        ->get(['id', 'name', 'pos_config_id', 'opened_at', 'order_count', 'order_amount_total']);

    if ($rows->isEmpty()) {
        $this->info('No open rescue sessions.');

        return;
    }

    $this->warn($rows->count().' open rescue session(s) need reconciliation:');
    $this->table(
        ['id', 'name', 'config', 'opened', 'orders', 'total'],
        $rows->map(static fn (object $r): array => (array) $r)->all(),
    );
})->purpose('List rescue sessions awaiting manager reconciliation');

Schedule::command('pos:prune-sync-requests')->dailyAt('03:15');
Schedule::command('pos:expire-print-jobs')->hourly();
Schedule::command('pos:report-rescue-sessions')->dailyAt('07:00');
