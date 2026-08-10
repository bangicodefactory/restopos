<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\AccountingExportFormat;
use App\Enums\AccountingExportState;
use App\Enums\MediaCollection;
use App\Enums\SessionState;
use App\Models\Identity\MediaFile;
use App\Models\Pos\AccountingExport;
use DomainException;
use Illuminate\Contracts\Filesystem\Factory as FilesystemFactory;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Builds an `accounting_exports` row for a date range (spec 02 BOF-150…159).
 *
 * The export reads the **frozen** session summaries, never the live order rows:
 * a session that has been exported must produce byte-identical figures on a
 * re-export, otherwise a correction made after the fact silently rewrites a
 * closed period.
 *
 * **A session is exported exactly once.** The pivot is not bookkeeping, it is the
 * guard: without reading it back, re-running a period hands the ledger a second
 * copy of the same month at full value, and nothing downstream can tell the two
 * apart. So the session query excludes anything already sitting in
 * `accounting_export_session`, and the whole build — row, pivot, file, state —
 * commits together or not at all. A half-written export that claimed sessions it
 * never put in a file would strand them permanently.
 *
 * `imbalance_amount` is the sanity check every accountant asks for first: sales
 * + tax + rounding should equal payments; anything else is surfaced loudly
 * instead of being quietly rounded away. The rounding term is what makes a
 * cash-rounded period balance — leave it out and every such period reports a
 * permanent discrepancy the accountant chases forever.
 */
final readonly class AccountingExportService
{
    public function __construct(
        private ConnectionInterface $connection,
        private FilesystemFactory $filesystem,
    ) {}

    /**
     * @param  list<int>|null  $sessionIds  null = every closed, unexported session in range
     */
    public function build(
        int $companyId,
        string $periodStart,
        string $periodEnd,
        AccountingExportFormat $format = AccountingExportFormat::Csv,
        ?array $sessionIds = null,
        ?int $userId = null,
    ): AccountingExport {
        $sessions = $this->connection->table('pos_sessions')
            ->where('company_id', $companyId)
            ->where('state', SessionState::Closed->value)
            ->whereBetween('business_date', [$periodStart, $periodEnd])
            ->when($sessionIds !== null, fn ($q) => $q->whereIn('id', $sessionIds))
            // The double-counting guard. `whereNotExists` against the pivot rather than a flag on
            // the session, because the pivot is what actually records which export consumed it.
            ->whereNotExists(fn ($q) => $q
                ->from('accounting_export_session')
                ->join(
                    'accounting_exports',
                    'accounting_exports.id',
                    '=',
                    'accounting_export_session.accounting_export_id',
                )
                ->whereColumn('accounting_export_session.pos_session_id', 'pos_sessions.id')
                // A failed build must not lock its sessions away: only an export that reached a
                // state where it actually consumed them counts as having claimed them.
                ->whereIn('accounting_exports.state', AccountingExportState::consuming()))
            ->orderBy('business_date')
            ->get();

        if ($sessions->isEmpty()) {
            throw new DomainException('No closed, unexported sessions in that period.');
        }

        $ids = $sessions->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        $sales = $this->aggregate('session_sales_summaries', $ids, [
            'base_amount', 'discount_amount', 'tax_amount', 'total_amount', 'cost_amount',
        ]);
        $taxes = $this->aggregate('session_tax_summaries', $ids, ['base_amount', 'tax_amount']);
        $payments = $this->aggregate('session_payment_totals', $ids, ['expected_amount', 'difference_amount']);
        $sessionTotals = $this->aggregate('pos_sessions', $ids, ['rounding_total', 'write_off_total'], 'id');

        $totalSales = $sales['base_amount'];
        $totalTax = $taxes['tax_amount'];
        $totalPayments = $payments['expected_amount'];
        $totalRounding = $sessionTotals['rounding_total'];
        $totalWriteOff = $sessionTotals['write_off_total'];

        // sales + tax + rounding − write-off − payments. The rounding delta is the amount the cash
        // total was moved by, so it belongs on the sales side of the identity, not the payments
        // side. Write-offs sit on the same side and subtract: they are revenue the summaries
        // recorded at the catalogue price and the drawer never received (BAN-514). Netting them
        // here is what keeps a stale-price sale from arriving as an unexplained imbalance — and
        // the amount stays visible as its own column and its own detail row, never absorbed.
        $imbalance = bcsub(
            bcsub(bcadd(bcadd($totalSales, $totalTax, 4), $totalRounding, 4), $totalWriteOff, 4),
            $totalPayments,
            4,
        );

        try {
            return $this->connection->transaction(function () use (
                $companyId, $periodStart, $periodEnd, $format, $userId, $ids,
                $totalSales, $totalTax, $totalPayments, $totalRounding, $totalWriteOff, $imbalance,
            ): AccountingExport {
                /** @var AccountingExport $export */
                $export = AccountingExport::query()->create([
                    'uuid' => (string) Str::uuid(),
                    'company_id' => $companyId,
                    'period_start' => $periodStart,
                    'period_end' => $periodEnd,
                    'format' => $format->value,
                    'state' => AccountingExportState::Draft->value,
                    'session_count' => count($ids),
                    'total_sales' => $totalSales,
                    'total_tax' => $totalTax,
                    'total_payments' => $totalPayments,
                    'total_rounding' => $totalRounding,
                    'total_write_off' => $totalWriteOff,
                    'imbalance_amount' => $imbalance,
                    'generated_by_user_id' => $userId,
                ]);

                // One statement, not one per session: a month of two registers is ~60 round trips
                // inside the transaction otherwise. This is also where a concurrent build loses —
                // `accounting_export_session_once` rejects a session another export already holds.
                $this->connection->table('accounting_export_session')->insert(
                    array_map(static fn (int $sessionId): array => [
                        'accounting_export_id' => $export->getKey(),
                        'pos_session_id' => $sessionId,
                    ], $ids),
                );

                $body = $format === AccountingExportFormat::Json
                    ? $this->renderJson($export, $ids)
                    : $this->renderCsv($ids, $companyId);

                $media = $this->persist($export, $companyId, $format, $body);

                $this->connection->table('pos_sessions')
                    ->whereIn('id', $ids)
                    ->update(['accounting_exported_at' => Carbon::now()]);

                $export->forceFill([
                    'state' => AccountingExportState::Exported->value,
                    'media_file_id' => $media->getKey(),
                    'error_message' => null,
                ])->save();

                return $export;
            });
        } catch (\Throwable $e) {
            // The transaction rolled the whole attempt back, sessions included, so they stay
            // available for the next run. Record the failure outside it so the operator can see
            // what happened rather than being told nothing at all — with the full set of figures,
            // because a row showing an imbalance and no components explains nothing.
            /** @var AccountingExport $failed */
            $failed = AccountingExport::query()->create([
                'uuid' => (string) Str::uuid(),
                'company_id' => $companyId,
                'period_start' => $periodStart,
                'period_end' => $periodEnd,
                'format' => $format->value,
                'state' => AccountingExportState::Failed->value,
                'session_count' => count($ids),
                'total_sales' => $totalSales,
                'total_tax' => $totalTax,
                'total_payments' => $totalPayments,
                'total_rounding' => $totalRounding,
                'total_write_off' => $totalWriteOff,
                'imbalance_amount' => $imbalance,
                'generated_by_user_id' => $userId,
                'error_message' => $this->describe($e),
            ]);

            return $failed;
        }
    }

    /**
     * Turn a build failure into something an operator can act on.
     *
     * Losing the race for a session is the one failure with an obvious human explanation, and a
     * raw "UNIQUE constraint failed: accounting_export_session.pos_session_id" tells nobody that
     * their colleague simply got there first.
     */
    private function describe(\Throwable $e): string
    {
        if ($e instanceof UniqueConstraintViolationException
            || str_contains($e->getMessage(), 'accounting_export_session_once')) {
            return 'Another export claimed these sessions first. Reload and check the export list.';
        }

        return $e->getMessage();
    }

    /**
     * Write the generated bytes to disk and record them as a `media_files` row so the export has a
     * downloadable identity (BAN-393 / BAN-480 will fold this into the general pipeline).
     *
     * `is_public` stays false: an accounting export is the month's takings, and the disk it lands
     * on may well be web-served. It is reachable only through the authenticated download route.
     */
    private function persist(
        AccountingExport $export,
        int $companyId,
        AccountingExportFormat $format,
        string $body,
    ): MediaFile {
        $isJson = $format === AccountingExportFormat::Json;
        $filename = sprintf('%s.%s', $export->uuid, $isJson ? 'json' : 'csv');
        $path = 'accounting-exports/'.$filename;
        $disk = $this->filesystem->disk();

        $disk->put($path, $body);

        /** @var MediaFile $media */
        $media = MediaFile::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $companyId,
            'model_type' => $export->getMorphClass(),
            'model_id' => $export->getKey(),
            'collection' => MediaCollection::Document->value,
            'disk' => config('filesystems.default'),
            'path' => $path,
            'filename' => $filename,
            'mime_type' => $isJson ? 'application/json' : 'text/csv',
            'size_bytes' => strlen($body),
            'checksum' => hash('sha256', $body),
            'is_public' => false,
        ]);

        return $media;
    }

    /**
     * @param  list<int>  $sessionIds
     * @param  list<string>  $columns
     * @return array<string, string>
     */
    private function aggregate(string $table, array $sessionIds, array $columns, string $key = 'pos_session_id'): array
    {
        $query = $this->connection->table($table)->whereIn($key, $sessionIds);

        foreach ($columns as $column) {
            $query->selectRaw("coalesce(sum({$column}), 0) as {$column}");
        }

        $row = $query->first();
        $out = [];

        foreach ($columns as $column) {
            $out[$column] = bcadd((string) ($row->{$column} ?? '0'), '0', 4);
        }

        return $out;
    }

    /**
     * @param  list<int>  $sessionIds
     * @param  int  $companyId  scopes the label lookups; the summaries are already session-scoped
     */
    private function renderCsv(array $sessionIds, int $companyId): string
    {
        $rows = [['session_id', 'business_date', 'kind', 'key', 'label', 'base', 'tax', 'total']];

        // The header has always promised a business date and every row has always shipped it empty.
        // An export the accountant cannot sort by date is most of the way to useless, and the
        // sessions are already in hand.
        $businessDates = $this->connection->table('pos_sessions')
            ->whereIn('id', $sessionIds)
            ->pluck('business_date', 'id');

        $dateOf = static fn (mixed $sessionId): string => (string) ($businessDates[$sessionId] ?? '');

        foreach ($this->connection->table('session_sales_summaries')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                $dateOf($row->pos_session_id),
                'sales',
                (string) $row->tax_signature,
                (string) ($row->ledger_code ?? ''),
                (string) $row->base_amount,
                (string) $row->tax_amount,
                (string) $row->total_amount,
            ];
        }

        // A tax row's account is the tax group's, which has no ledger code of its own — the group's
        // receipt label is the name the accountant already sees on the till roll, so the column
        // carries something meaningful for this row kind too rather than being blank.
        $taxGroupLabels = $this->connection->table('tax_groups')
            ->where('company_id', $companyId)
            ->pluck($this->connection->raw('coalesce(receipt_label, name)'), 'id');

        foreach ($this->connection->table('session_tax_summaries')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                $dateOf($row->pos_session_id),
                'tax',
                (string) $row->tax_id,
                (string) ($taxGroupLabels[$row->tax_group_id] ?? ''),
                (string) $row->base_amount,
                (string) $row->tax_amount,
                (string) $row->tax_amount,
            ];
        }

        foreach ($this->connection->table('session_payment_totals')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                $dateOf($row->pos_session_id),
                'payment',
                (string) $row->payment_method_id,
                (string) ($row->ledger_code ?? ''),
                '0',
                '0',
                (string) $row->expected_amount,
            ];
        }

        // One row per session that forgave something, and only then. A write-off is the reason the
        // sales rows above total more than the payment rows below, so an export carrying one has to
        // say so on its face — otherwise the accountant reconciles by hand and finds a gap the file
        // does not explain (BAN-514).
        foreach ($this->connection->table('pos_sessions')
            ->whereIn('id', $sessionIds)
            ->where('write_off_total', '!=', 0)
            ->get(['id', 'write_off_total', 'name']) as $row) {
            $rows[] = [
                (string) $row->id,
                $dateOf($row->id),
                'write_off',
                (string) $row->id,
                (string) ($row->name ?? ''),
                '0',
                '0',
                (string) $row->write_off_total,
            ];
        }

        $out = '';

        foreach ($rows as $row) {
            $out .= implode(',', array_map(static fn (string $c): string => '"'.str_replace('"', '""', $c).'"', $row))."\n";
        }

        return $out;
    }

    /** @param list<int> $sessionIds */
    private function renderJson(AccountingExport $export, array $sessionIds): string
    {
        return (string) json_encode([
            'export' => [
                'uuid' => (string) $export->uuid,
                'period_start' => (string) $export->period_start,
                'period_end' => (string) $export->period_end,
                'generated_at' => Carbon::now()->toIso8601ZuluString('second'),
                'total_sales' => (string) $export->total_sales,
                'total_tax' => (string) $export->total_tax,
                'total_payments' => (string) $export->total_payments,
                // Both terms of the identity that sit on the sales side. `total_rounding` was
                // missing here as well, so a JSON reader could not check sales + tax + rounding −
                // write-off − payments = imbalance without going back to the database (BAN-514).
                'total_rounding' => (string) $export->total_rounding,
                'total_write_off' => (string) $export->total_write_off,
                'imbalance_amount' => (string) $export->imbalance_amount,
            ],
            'sessions' => $sessionIds,
            'sales' => $this->connection->table('session_sales_summaries')->whereIn('pos_session_id', $sessionIds)->get(),
            'taxes' => $this->connection->table('session_tax_summaries')->whereIn('pos_session_id', $sessionIds)->get(),
            'payments' => $this->connection->table('session_payment_totals')->whereIn('pos_session_id', $sessionIds)->get(),
            'write_offs' => $this->connection->table('pos_sessions')
                ->whereIn('id', $sessionIds)
                ->where('write_off_total', '!=', 0)
                ->get(['id', 'name', 'business_date', 'write_off_total']),
        ], JSON_PRETTY_PRINT);
    }
}
