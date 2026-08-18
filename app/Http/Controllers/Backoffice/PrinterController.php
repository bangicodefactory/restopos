<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\PrinterRequest;
use App\Models\Catalog\PosCategory;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPrinter;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
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

    /** `POST /printers` — add a printer (BOF-114). */
    public function store(PrinterRequest $request): RedirectResponse
    {
        $data = $request->validated();
        $categoryIds = $this->ownedCategories($data['category_ids'] ?? null);
        unset($data['category_ids']);

        $companyId = ActingCompany::id();

        // A super-admin acts across companies and so has no company of their own to file this under.
        // Refused rather than guessed: a printer filed against the wrong tenant is invisible to the
        // venue that needs it and visible to one that does not.
        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a printer.',
            ]);
        }

        /** @var PosPrinter $printer */
        $printer = PosPrinter::query()->create([...$data, 'company_id' => $companyId]);

        if ($categoryIds !== null) {
            $this->routeCategories($printer, $categoryIds);
        }

        return back()->with('success', 'Printer added.');
    }

    public function update(PrinterRequest $request, PosPrinter $printer): RedirectResponse
    {
        $data = $request->validated();
        $categoryIds = $this->ownedCategories($data['category_ids'] ?? null);
        unset($data['category_ids']);

        if ($categoryIds !== null) {
            $this->routeCategories($printer, $categoryIds);
        }

        $printer->forceFill($data)->save();

        return back()->with('success', 'Printer saved.');
    }

    /**
     * `DELETE /printers/{printer}` — remove a printer (BOF-114).
     *
     * Refused while work is still queued for it. Those rows are food waiting to be cooked: deleting
     * the printer cascades them away, and the order they belong to says the kitchen was told. The
     * operator is told which jobs are in the way rather than being handed a number to interpret,
     * matching how a floor with open bills refuses deletion (RST-032).
     */
    public function destroy(Request $request, PosPrinter $printer): RedirectResponse
    {
        // Scoped, like every other raw builder query on a company-owned table. The printer is
        // already this tenant's, so in practice its jobs are too — but `TenantIsolationTest` checks
        // the *shape* rather than the reasoning, and it is right to: the day this method grows a
        // second condition, the reasoning is what stops being true.
        $pending = $this->connection->table('preparation_print_jobs')
            ->where('pos_printer_id', $printer->getKey())
            ->whereIn('state', [PrintJobState::Queued->value, PrintJobState::Failed->value]);

        ActingCompany::scope($pending);

        $pending = $pending->count();

        if ($pending > 0) {
            throw ValidationException::withMessages([
                'printer' => 'This printer still has '.$pending.' job(s) waiting. Clear them first.',
            ]);
        }

        // The pivot goes with it: `pos_category_pos_printer.pos_printer_id` is `cascadeOnDelete`, so
        // deleting the rows here first changed nothing — sabotaging that line left every test green,
        // which is how it was found. The database owns this one.
        $printer->delete();

        return back()->with('success', 'Printer removed.');
    }

    /**
     * The submitted category ids, confirmed to be this company's.
     *
     * Null when the payload did not mention them at all, which means "leave the routing alone" — as
     * distinct from an empty array, which means "route nothing".
     *
     * Resolved through the scoped model rather than an `exists` rule: the pivot has no company of
     * its own, and the rule cannot be written in the request because a super-admin has no
     * `company_id` to compare against. Any id that does not survive is a **422**, not a silent drop —
     * dropping it would quietly unroute the printer, and the first anybody would know is food not
     * being cooked.
     *
     * @param  array<int, mixed>|null  $ids
     * @return list<int>|null
     */
    private function ownedCategories(?array $ids): ?array
    {
        if ($ids === null) {
            return null;
        }

        $wanted = array_values(array_unique(array_map(intval(...), $ids)));

        /** @var list<int> $owned */
        $owned = PosCategory::query()->whereIn('id', $wanted)->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)->all();

        $missing = array_values(array_diff($wanted, $owned));

        if ($missing !== []) {
            throw ValidationException::withMessages([
                'category_ids' => 'Unknown product category: '.implode(', ', $missing).'.',
            ]);
        }

        return $owned;
    }

    /** @param  list<int>  $categoryIds */
    private function routeCategories(PosPrinter $printer, array $categoryIds): void
    {
        $this->connection->table('pos_category_pos_printer')->where('pos_printer_id', $printer->getKey())->delete();

        foreach ($categoryIds as $categoryId) {
            $this->connection->table('pos_category_pos_printer')->insert([
                'pos_printer_id' => $printer->getKey(),
                'pos_category_id' => $categoryId,
            ]);
        }
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
