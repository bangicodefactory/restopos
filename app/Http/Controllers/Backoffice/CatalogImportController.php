<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\Product;
use App\Services\Import\CatalogImportService;
use App\Support\Import\Importers;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Bringing a catalogue in from a spreadsheet (BOF-093, BAN-491).
 *
 * Every DataTable and report exports to CSV; nothing imported. Onboarding a venue with a 300-item
 * menu meant 300 manual creations.
 *
 * ## Preview, then commit
 *
 * The file is parsed and planned on upload, and **nothing is written**. The operator sees, per row,
 * whether it would create, update or fail and why. Only then is there something to press.
 *
 * The plan is not stored between the two requests: the file is re-posted with the commit. That is
 * one more upload and it removes a whole class of problem — a plan held in a session while the
 * catalogue changes underneath it describes a state that no longer exists, and the operator would be
 * committing an answer to a question nobody asked any more.
 *
 * ## Why the file is parsed here and not in the browser
 *
 * The rules that decide whether a row is valid are the server's, and they have to be: an import
 * validated in JavaScript is an import a crafted request walks straight past. The browser only shows
 * what the server decided.
 */
final class CatalogImportController extends Controller
{
    /** Bigger than any real menu. Refused with the count, never silently cut. */
    private const MAX_BYTES = 4 * 1024 * 1024;

    public function index(): Response
    {
        Gate::authorize('create', Product::class);

        return Inertia::render('CatalogImport/Index', [
            'entities' => collect(Importers::all())->map(static fn (array $spec, string $key): array => [
                'key' => $key,
                'label' => $spec['label'],
                'columns' => $spec['columns'],
                'required' => $spec['required'],
                'keys' => $spec['keys'],
            ])->values()->all(),
            'maxRows' => CatalogImportService::MAX_ROWS,
        ]);
    }

    /** `POST /catalog-import/preview` — what this file would do, without doing it. */
    public function preview(Request $request, CatalogImportService $service): RedirectResponse
    {
        Gate::authorize('create', Product::class);

        [$entity, $rows] = $this->readFile($request);

        $plan = $service->plan($entity, $rows, $this->companyId());

        return back()->with('import', [
            'entity' => $entity,
            'committed' => false,
            'creates' => $plan->createCount(),
            'updates' => $plan->updateCount(),
            'errors' => $plan->errorCount(),
            'rows' => $plan->toArray(),
        ]);
    }

    /**
     * `POST /catalog-import` — apply it.
     *
     * The plan is recomputed here rather than trusted from the preview. Between the two requests the
     * catalogue can change — another operator adds the product this file was going to create — and
     * the only honest thing to commit is a plan made against the catalogue as it is now.
     */
    public function store(Request $request, CatalogImportService $service): RedirectResponse
    {
        Gate::authorize('create', Product::class);

        [$entity, $rows] = $this->readFile($request);

        $plan = $service->commit($entity, $rows, $this->companyId());

        if (! $plan->isClean()) {
            return back()->with('import', [
                'entity' => $entity,
                'committed' => false,
                'creates' => $plan->createCount(),
                'updates' => $plan->updateCount(),
                'errors' => $plan->errorCount(),
                'rows' => $plan->toArray(),
            ])->withErrors([
                'file' => $plan->errorCount().' row(s) could not be imported, so nothing was written.'
                    .' A half-imported catalogue is worse than none: fix the file and upload it again.',
            ]);
        }

        return back()->with('import', [
            'entity' => $entity,
            'committed' => true,
            'creates' => $plan->createCount(),
            'updates' => $plan->updateCount(),
            'errors' => 0,
            'rows' => $plan->toArray(),
        ]);
    }

    /**
     * `GET /catalog-import/{entity}/template` — an empty file with the right header.
     *
     * The most common import failure is a column name the importer does not recognise, and the
     * cheapest fix is to hand the operator the header rather than ask them to transcribe it.
     */
    public function template(string $entity): StreamedResponse
    {
        Gate::authorize('create', Product::class);

        $spec = Importers::all()[$entity] ?? null;

        abort_if($spec === null, 404);

        return response()->streamDownload(function () use ($spec): void {
            $handle = fopen('php://output', 'wb');
            fputcsv($handle, $spec['columns']);
            fclose($handle);
        }, $entity.'-template.csv', ['Content-Type' => 'text/csv']);
    }

    /**
     * The uploaded file, parsed.
     *
     * @return array{string, list<array<string, string>>}
     */
    private function readFile(Request $request): array
    {
        $data = $request->validate([
            'entity' => ['required', 'string', 'in:'.implode(',', array_keys(Importers::all()))],
            // `mimes:csv,txt` reads the file's own bytes rather than trusting the name — the same
            // reason the media pipeline uses it (BAN-393).
            'file' => ['required', 'file', 'mimes:csv,txt', 'max:'.(self::MAX_BYTES / 1024)],
        ]);

        $path = $data['file']->getRealPath();
        $handle = fopen($path, 'rb');

        if ($handle === false) {
            throw ValidationException::withMessages(['file' => 'That file could not be read.']);
        }

        $header = fgetcsv($handle);

        if ($header === false || $header === [null]) {
            fclose($handle);

            throw ValidationException::withMessages([
                'file' => 'That file has no header row, so there is no way to tell which column is which.',
            ]);
        }

        // A UTF-8 BOM in front of the first header is what Excel writes by default, and it turns
        // `name` into `\u{FEFF}name` — a column the importer does not recognise, on the one field
        // every entity requires. Every row then fails for a missing name that is plainly there.
        $header = array_map(
            static fn (?string $column): string => trim(str_replace("\u{FEFF}", '', (string) $column)),
            $header,
        );

        $rows = [];

        while (($line = fgetcsv($handle)) !== false) {
            if ($line === [null]) {
                continue; // a blank line at the end of the file, which every editor adds
            }

            if (\count($rows) >= CatalogImportService::MAX_ROWS) {
                fclose($handle);

                throw ValidationException::withMessages([
                    'file' => 'That file has more than '.CatalogImportService::MAX_ROWS.' rows.'
                        .' Split it — nothing was imported.',
                ]);
            }

            $row = [];

            foreach ($header as $i => $column) {
                $row[$column] = (string) ($line[$i] ?? '');
            }

            $rows[] = $row;
        }

        fclose($handle);

        if ($rows === []) {
            throw ValidationException::withMessages(['file' => 'That file has a header and no rows.']);
        }

        return [$data['entity'], $rows];
    }

    private function companyId(): int
    {
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'file' => 'Choose a company before importing.',
            ]);
        }

        return $companyId;
    }
}
