<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\AccountingExportFormat;
use App\Enums\AccountingExportState;
use App\Enums\SessionState;
use App\Models\Pos\AccountingExport;
use DomainException;
use Illuminate\Contracts\Filesystem\Factory as FilesystemFactory;
use Illuminate\Database\ConnectionInterface;
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
 * `imbalance_amount` is the sanity check every accountant asks for first: sales
 * + tax should equal payments; anything else is surfaced loudly instead of being
 * quietly rounded away.
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
            ->orderBy('business_date')
            ->get();

        if ($sessions->isEmpty()) {
            throw new DomainException('No closed sessions in that period.');
        }

        $ids = $sessions->pluck('id')->map(static fn (mixed $v): int => (int) $v)->all();

        $sales = $this->aggregate('session_sales_summaries', $ids, [
            'base_amount', 'discount_amount', 'tax_amount', 'total_amount', 'cost_amount',
        ]);
        $taxes = $this->aggregate('session_tax_summaries', $ids, ['base_amount', 'tax_amount']);
        $payments = $this->aggregate('session_payment_totals', $ids, ['expected_amount', 'difference_amount']);

        $totalSales = $sales['base_amount'];
        $totalTax = $taxes['tax_amount'];
        $totalPayments = $payments['expected_amount'];
        $imbalance = bcsub(bcadd($totalSales, $totalTax, 4), $totalPayments, 4);

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
            'imbalance_amount' => $imbalance,
            'generated_by_user_id' => $userId,
        ]);

        foreach ($ids as $sessionId) {
            $this->connection->table('accounting_export_session')->insert([
                'accounting_export_id' => $export->getKey(),
                'pos_session_id' => $sessionId,
            ]);
        }

        try {
            $body = $format === AccountingExportFormat::Json
                ? $this->renderJson($export, $ids)
                : $this->renderCsv($ids);

            $path = sprintf('accounting-exports/%s.%s', $export->uuid, $format === AccountingExportFormat::Json ? 'json' : 'csv');
            $this->filesystem->disk()->put($path, $body);

            $export->forceFill([
                'state' => AccountingExportState::Generated->value,
                'error_message' => null,
            ])->save();
        } catch (\Throwable $e) {
            $export->forceFill([
                'state' => AccountingExportState::Failed->value,
                'error_message' => $e->getMessage(),
            ])->save();
        }

        return $export;
    }

    /**
     * @param  list<int>  $sessionIds
     * @param  list<string>  $columns
     * @return array<string, string>
     */
    private function aggregate(string $table, array $sessionIds, array $columns): array
    {
        $query = $this->connection->table($table)->whereIn('pos_session_id', $sessionIds);

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

    /** @param list<int> $sessionIds */
    private function renderCsv(array $sessionIds): string
    {
        $rows = [['session_id', 'business_date', 'kind', 'key', 'label', 'base', 'tax', 'total']];

        foreach ($this->connection->table('session_sales_summaries')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                '',
                'sales',
                (string) $row->tax_signature,
                (string) ($row->ledger_code ?? ''),
                (string) $row->base_amount,
                (string) $row->tax_amount,
                (string) $row->total_amount,
            ];
        }

        foreach ($this->connection->table('session_tax_summaries')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                '',
                'tax',
                (string) $row->tax_id,
                '',
                (string) $row->base_amount,
                (string) $row->tax_amount,
                (string) $row->tax_amount,
            ];
        }

        foreach ($this->connection->table('session_payment_totals')->whereIn('pos_session_id', $sessionIds)->get() as $row) {
            $rows[] = [
                (string) $row->pos_session_id,
                '',
                'payment',
                (string) $row->payment_method_id,
                (string) ($row->ledger_code ?? ''),
                '0',
                '0',
                (string) $row->expected_amount,
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
                'imbalance_amount' => (string) $export->imbalance_amount,
            ],
            'sessions' => $sessionIds,
            'sales' => $this->connection->table('session_sales_summaries')->whereIn('pos_session_id', $sessionIds)->get(),
            'taxes' => $this->connection->table('session_tax_summaries')->whereIn('pos_session_id', $sessionIds)->get(),
            'payments' => $this->connection->table('session_payment_totals')->whereIn('pos_session_id', $sessionIds)->get(),
        ], JSON_PRETTY_PRINT);
    }
}
