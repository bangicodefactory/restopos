<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPrinter;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Printers/Index` (spec 02 KDS-050, KDS-063).
 *
 * The test action queues a real print job rather than pinging the device: the
 * only meaningful test of a kitchen printer is a piece of paper coming out of it.
 */
final class PrinterController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        return Inertia::render('Printers/Index', [
            'printers' => PosPrinter::query()->orderBy('name')->get()->map(function (PosPrinter $p): array {
                return [
                    'id' => (int) $p->getKey(),
                    'name' => (string) $p->name,
                    'printer_type' => (string) ($p->printer_type?->value ?? $p->printer_type),
                    'proxy_ip' => $p->proxy_ip,
                    'printer_ip' => $p->printer_ip,
                    'printer_port' => $p->printer_port,
                    'is_receipt_printer' => (bool) $p->is_receipt_printer,
                    'print_all_categories' => (bool) $p->print_all_categories,
                    'characters_per_line' => (int) $p->characters_per_line,
                    'copies' => (int) $p->copies,
                    'active' => (bool) $p->active,
                    'category_ids' => $this->connection->table('pos_category_pos_printer')
                        ->where('pos_printer_id', $p->getKey())->pluck('pos_category_id')->map(static fn (mixed $v): int => (int) $v)->all(),
                ];
            })->values()->all(),
            'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all(),
            // A query-builder call, so the global scope never sees it: unscoped, this listed every
            // tenant's print jobs and their error text (XCT-101).
            'queue' => Inertia::defer(function (): array {
                $queue = $this->connection->table('preparation_print_jobs')
                    ->whereIn('state', [PrintJobState::Queued->value, PrintJobState::Failed->value]);

                ActingCompany::scope($queue);

                return $queue->orderByDesc('queued_at')->limit(100)
                    ->get(['id', 'uuid', 'pos_printer_id', 'job_type', 'state', 'attempts', 'last_error', 'queued_at'])
                    ->map(static fn ($r): array => (array) $r)->all();
            }),
        ]);
    }

    public function update(Request $request, PosPrinter $printer): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:64'],
            'proxy_ip' => ['sometimes', 'nullable', 'string', 'max:64'],
            'printer_ip' => ['sometimes', 'nullable', 'string', 'max:128'],
            'printer_port' => ['sometimes', 'nullable', 'integer'],
            'is_receipt_printer' => ['sometimes', 'boolean'],
            'print_all_categories' => ['sometimes', 'boolean'],
            'characters_per_line' => ['sometimes', 'integer', 'min:24', 'max:96'],
            'copies' => ['sometimes', 'integer', 'min:1', 'max:5'],
            'active' => ['sometimes', 'boolean'],
            'category_ids' => ['sometimes', 'array'],
        ]);

        if (array_key_exists('category_ids', $data)) {
            // The ids arrive from the browser and land in a pivot with no company of its own, so
            // they are filtered through the scoped model rather than trusted — otherwise a printer
            // could be routed by another tenant's category (XCT-101).
            $categoryIds = PosCategory::query()
                ->whereIn('id', array_map(intval(...), (array) $data['category_ids']))
                ->pluck('id');

            $this->connection->table('pos_category_pos_printer')->where('pos_printer_id', $printer->getKey())->delete();

            foreach ($categoryIds as $categoryId) {
                $this->connection->table('pos_category_pos_printer')->insert([
                    'pos_printer_id' => $printer->getKey(),
                    'pos_category_id' => (int) $categoryId,
                ]);
            }

            unset($data['category_ids']);
        }

        $printer->forceFill($data)->save();

        return back()->with('success', 'Printer saved.');
    }

    /** Queue a test ticket; the printer agent picks it up on its next poll. */
    public function test(Request $request, PosPrinter $printer): RedirectResponse
    {
        $request->validate(['pos_config_id' => ['required', 'integer']]);

        // `exists:pos_configs,id` runs unscoped and would accept another company's register, filing
        // this job against a config its own company does not own. Resolve it through the scoped
        // model instead, which 404s on a foreign id (XCT-101).
        $config = PosConfig::query()->findOrFail($request->integer('pos_config_id'));

        $this->connection->table('preparation_print_jobs')->insert([
            'uuid' => (string) Str::uuid(),
            'company_id' => (int) $printer->company_id,
            'pos_config_id' => $config->getKey(),
            'pos_printer_id' => $printer->getKey(),
            'job_type' => PrintJobType::Test->value,
            'payload' => json_encode([
                'v' => 1,
                'kind' => 'test',
                'printer' => ['id' => (int) $printer->getKey(), 'name' => (string) $printer->name, 'characters_per_line' => (int) $printer->characters_per_line],
                'header' => ['station' => (string) $printer->name, 'fired_at' => now()->toIso8601ZuluString('second')],
                'courses' => [],
                'notes' => ['RestoPOS printer test'],
            ]),
            'copies' => 1,
            'state' => PrintJobState::Queued->value,
            'queued_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return back()->with('success', 'Test ticket queued.');
    }
}
