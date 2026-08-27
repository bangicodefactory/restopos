<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\BarcodeEncoding;
use App\Enums\BarcodeRuleType;
use App\Enums\UpcEanConversion;
use App\Http\Controllers\Controller;
use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Catalog\BarcodeRule;
use App\Models\Scopes\CompanyScope;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Barcode nomenclatures and their rules (BOF-043, BAN-488).
 *
 * A nomenclature is how a venue reads the barcodes on its own shelves. A supermarket that prints
 * weight into an EAN-13 — `21` then the product code then the grams — needs a rule saying which
 * digits are which, or every scan of a weighed item is either a miss or the wrong product at the
 * wrong price. The tables, the models and the enums have all existed since the catalogue schema was
 * written; there was no route, no controller and no page, so the rules could only be seeded.
 *
 * ## The nullable company
 *
 * `barcode_nomenclatures.company_id` is **nullable**, and that is deliberate: the standard EAN-13
 * and UPC-A nomenclatures are the same everywhere and ship as shared rows. So "ours" here means
 * *ours or global*, and a global one is readable by everyone and editable by nobody through this
 * screen — an edit would silently change what every venue on the instance scans.
 */
final class BarcodeNomenclatureController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', BarcodeNomenclature::class);

        return Inertia::render('BarcodeNomenclatures/Index', [
            'nomenclatures' => $this->visible()
                ->with(['rules' => fn ($q) => $q->orderBy('sequence')->orderBy('id')])
                ->orderBy('name')
                ->get()
                ->map(fn (BarcodeNomenclature $n): array => [
                    'id' => (int) $n->getKey(),
                    'name' => (string) $n->name,
                    'upc_ean_conv' => (string) ($n->upc_ean_conv?->value ?? $n->upc_ean_conv),
                    'is_gs1' => (bool) $n->is_gs1,
                    // A shared row is offered read-only. Editing one would change what every venue
                    // on the instance scans, which is not a thing one venue's manager may do.
                    'is_shared' => $n->company_id === null,
                    'rules' => $n->rules->map(static fn (BarcodeRule $r): array => [
                        'id' => (int) $r->getKey(),
                        'name' => (string) $r->name,
                        'rule_type' => (string) ($r->rule_type?->value ?? $r->rule_type),
                        'pattern' => (string) $r->pattern,
                        'encoding' => (string) ($r->encoding?->value ?? $r->encoding),
                        'alias' => $r->alias,
                        'sequence' => (int) $r->sequence,
                        'active' => (bool) $r->active,
                    ])->values()->all(),
                ])->values()->all(),
            'rule_types' => array_map(
                static fn (BarcodeRuleType $t): array => ['value' => $t->value, 'label' => $t->value],
                BarcodeRuleType::cases(),
            ),
            'encodings' => array_map(
                static fn (BarcodeEncoding $e): array => ['value' => $e->value, 'label' => $e->value],
                BarcodeEncoding::cases(),
            ),
            'conversions' => array_map(
                static fn (UpcEanConversion $c): array => ['value' => $c->value, 'label' => $c->value],
                UpcEanConversion::cases(),
            ),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', BarcodeNomenclature::class);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:64'],
            'upc_ean_conv' => ['sometimes', Rule::enum(UpcEanConversion::class)],
            'is_gs1' => ['sometimes', 'boolean'],
        ]);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a nomenclature.',
            ]);
        }

        BarcodeNomenclature::query()->create([...$data, 'company_id' => $companyId]);

        return back()->with('success', 'Nomenclature added.');
    }

    public function update(Request $request, BarcodeNomenclature $nomenclature): RedirectResponse
    {
        Gate::authorize('update', $nomenclature);
        $this->refuseShared($nomenclature);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:64'],
            'upc_ean_conv' => ['sometimes', Rule::enum(UpcEanConversion::class)],
            'is_gs1' => ['sometimes', 'boolean'],
        ]);

        $nomenclature->forceFill($data)->save();

        return back()->with('success', 'Nomenclature saved.');
    }

    /**
     * Refused while a register still points at it.
     *
     * `pos_configs.fallback_barcode_nomenclature_id` is `nullOnDelete`, so the database would let
     * this through and simply blank the register — every weighed-item scan on that till would start
     * missing, with nothing on any screen connecting the two events.
     */
    public function destroy(BarcodeNomenclature $nomenclature): RedirectResponse
    {
        Gate::authorize('delete', $nomenclature);
        $this->refuseShared($nomenclature);

        $registers = $this->connection->table('pos_configs')
            ->where('fallback_barcode_nomenclature_id', $nomenclature->getKey())
            ->where('company_id', $nomenclature->company_id)
            ->count();

        if ($registers > 0) {
            throw ValidationException::withMessages([
                'nomenclature' => 'This nomenclature is in use by '.$registers.' register(s). Point them'
                    .' at another one first, or their weighed-item scans will silently stop matching.',
            ]);
        }

        $nomenclature->delete();

        return back()->with('success', 'Nomenclature removed.');
    }

    public function storeRule(Request $request, BarcodeNomenclature $nomenclature): RedirectResponse
    {
        Gate::authorize('update', $nomenclature);
        $this->refuseShared($nomenclature);

        $data = $request->validate($this->ruleRules());

        $nomenclature->rules()->create([
            ...$data,
            'sequence' => $data['sequence'] ?? ((int) $nomenclature->rules()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Rule added.');
    }

    public function updateRule(Request $request, BarcodeNomenclature $nomenclature, BarcodeRule $rule): RedirectResponse
    {
        Gate::authorize('update', $nomenclature);
        $this->refuseShared($nomenclature);
        $this->refuseForeignRule($nomenclature, $rule);

        $rule->forceFill($request->validate($this->ruleRules(creating: false)))->save();

        return back()->with('success', 'Rule saved.');
    }

    public function destroyRule(BarcodeNomenclature $nomenclature, BarcodeRule $rule): RedirectResponse
    {
        Gate::authorize('update', $nomenclature);
        $this->refuseShared($nomenclature);
        $this->refuseForeignRule($nomenclature, $rule);

        $rule->delete();

        return back()->with('success', 'Rule removed.');
    }

    /** @return array<string, mixed> */
    private function ruleRules(bool $creating = true): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:64'],
            'rule_type' => [$required, Rule::enum(BarcodeRuleType::class)],
            // The pattern is what the scanner matches against, in the syntax
            // `packages/domain/src/barcode/pattern.ts` parses: literal digits, `.` for any single
            // character, and `{NNDDD}` for an embedded numeric field of N integer and D decimal
            // digits. That is Odoo's syntax, which is what the shelf labels already printed in
            // every European supermarket speak.
            //
            // Validated against it rather than left free, because a pattern the parser cannot read
            // is a rule that never matches — and the operator discovers that at the till, on a
            // weighed item, at the moment a customer is waiting.
            'pattern' => [$required, 'string', 'max:64', 'regex:/^(?:[0-9.]|\{N*D*\})+$/'],
            'encoding' => ['sometimes', Rule::enum(BarcodeEncoding::class)],
            'alias' => ['sometimes', 'nullable', 'string', 'max:64'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    /** Ours, or shared with everyone. */
    private function visible(): Builder
    {
        return BarcodeNomenclature::query()
            ->withoutGlobalScope(CompanyScope::class)
            ->where(function ($query): void {
                $query->whereNull('company_id');

                $companyId = ActingCompany::id();

                if (is_int($companyId)) {
                    $query->orWhere('company_id', $companyId);
                }

                if ($companyId === ActingCompany::UNRESTRICTED) {
                    $query->orWhereNotNull('company_id');
                }
            });
    }

    private function refuseShared(BarcodeNomenclature $nomenclature): void
    {
        if ($nomenclature->company_id !== null) {
            return;
        }

        throw ValidationException::withMessages([
            'nomenclature' => 'This is a standard nomenclature shared by every venue on this system.'
                .' Copy it into your own before changing anything — an edit here would change what'
                .' everyone scans.',
        ]);
    }

    private function refuseForeignRule(BarcodeNomenclature $nomenclature, BarcodeRule $rule): void
    {
        abort_unless((int) $rule->barcode_nomenclature_id === (int) $nomenclature->getKey(), 404);
    }
}
