<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Identity\Country;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\FiscalPositionTax;
use App\Models\Pricing\Tax;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Fiscal positions and their tax mappings (BOF-036, BAN-398).
 *
 * A fiscal position rewrites which tax applies. The everyday case in a restaurant is takeaway: the
 * same dish carries one VAT rate eaten in and another taken away, and the difference is not the
 * venue's to absorb — it is the tax authority's money either way.
 *
 * `FiscalPositionMapper` has implemented and tested that rewriting since it was written, and the
 * register applies a position correctly the moment one exists. **There was no way to create one.**
 * No route, no controller, no page — a venue needing takeaway VAT had to reach for SQL.
 *
 * ## A mapping with no destination is a deletion, not a mistake
 *
 * `fiscal_position_taxes.tax_dest_id` is nullable on purpose: mapping a tax to *nothing* is how an
 * export or exempt regime removes it entirely. The editor has to offer that as a first-class choice
 * rather than treating an empty field as an unfinished row, because "no tax at all" is exactly what
 * an exempt customer is entitled to.
 */
final class FiscalPositionController extends Controller
{
    public function index(): Response
    {
        Gate::authorize('viewAny', FiscalPosition::class);

        return Inertia::render('FiscalPositions/Index', [
            'positions' => FiscalPosition::query()
                ->with(['taxMappings.sourceTax:id,name,amount', 'taxMappings.destinationTax:id,name,amount'])
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(static fn (FiscalPosition $p): array => [
                    'id' => (int) $p->getKey(),
                    'name' => (string) $p->name,
                    'auto_apply' => (bool) $p->auto_apply,
                    'country_id' => $p->country_id,
                    'zip_from' => $p->zip_from,
                    'zip_to' => $p->zip_to,
                    'vat_required' => (bool) $p->vat_required,
                    'sequence' => (int) $p->sequence,
                    'active' => (bool) $p->active,
                    'mappings' => $p->taxMappings->map(static fn (FiscalPositionTax $m): array => [
                        'id' => (int) $m->getKey(),
                        'tax_src_id' => (int) $m->tax_src_id,
                        'source_name' => (string) ($m->sourceTax?->name ?? ''),
                        'tax_dest_id' => $m->tax_dest_id,
                        // Null is "removed entirely", which the page has to render as a choice
                        // rather than as a blank.
                        'destination_name' => $m->destinationTax?->name,
                    ])->values()->all(),
                ])->values()->all(),
            'taxes' => Tax::query()->where('active', true)->orderBy('name')->get(['id', 'name', 'amount'])->all(),
            // Countries are global ISO reference data with no `company_id`, so there is nothing to
            // scope — the same reasoning as currencies.
            'countries' => Country::query()->orderBy('name')->get(['id', 'code', 'name'])->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', FiscalPosition::class);

        $data = $request->validate($this->rules());

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a fiscal position.',
            ]);
        }

        FiscalPosition::query()->create([...$data, 'company_id' => $companyId]);

        return back()->with('success', 'Fiscal position added.');
    }

    public function update(Request $request, FiscalPosition $fiscalPosition): RedirectResponse
    {
        Gate::authorize('update', $fiscalPosition);

        $fiscalPosition->forceFill($request->validate($this->rules(creating: false)))->save();

        return back()->with('success', 'Fiscal position saved.');
    }

    /**
     * Refused while anything still points at it.
     *
     * Four tables reference a fiscal position: `pos_configs.default_fiscal_position_id`,
     * `pos_config_fiscal_position`, `customers.fiscal_position_id` and `pos_orders`. The first
     * three are `restrictOnDelete` or would silently blank; the orders are history and must keep
     * naming the regime they were taxed under.
     *
     * Deactivating is the right move and the message says so: the position stops being offered and
     * every past order keeps meaning what it meant.
     */
    public function destroy(FiscalPosition $fiscalPosition): RedirectResponse
    {
        Gate::authorize('delete', $fiscalPosition);

        // Through the model, not `$connection->table()` — `CompanyScope` is an Eloquent scope and
        // cannot reach the query builder. `TenantIsolationTest` fails the build for exactly this,
        // and it caught this method while it was being written.
        $orders = Order::query()
            ->where('fiscal_position_id', $fiscalPosition->getKey())
            ->count();

        if ($orders > 0) {
            throw ValidationException::withMessages([
                'position' => 'This position has taxed '.$orders.' order(s) and cannot be removed.'
                    .' Deactivate it instead — it stops being offered and every past order keeps'
                    .' saying which regime it was taxed under.',
            ]);
        }

        $registers = PosConfig::query()
            ->where('default_fiscal_position_id', $fiscalPosition->getKey())
            ->count();

        if ($registers > 0) {
            throw ValidationException::withMessages([
                'position' => 'This position is the default on '.$registers.' register(s). Point them'
                    .' at another one first.',
            ]);
        }

        $fiscalPosition->delete();

        return back()->with('success', 'Fiscal position removed.');
    }

    /**
     * `POST /fiscal-positions/{fiscalPosition}/mappings` — map one tax onto another, or onto none.
     */
    public function storeMapping(Request $request, FiscalPosition $fiscalPosition): RedirectResponse
    {
        Gate::authorize('update', $fiscalPosition);

        $data = $request->validate([
            'tax_src_id' => ['required', 'integer', $this->ownedTax()],
            // Nullable on purpose: mapping a tax to nothing removes it, which is what an export or
            // exempt regime does.
            'tax_dest_id' => ['sometimes', 'nullable', 'integer', $this->ownedTax()],
        ]);

        if (($data['tax_dest_id'] ?? null) !== null && (int) $data['tax_dest_id'] === (int) $data['tax_src_id']) {
            throw ValidationException::withMessages([
                'tax_dest_id' => 'A tax mapped to itself changes nothing. Choose a different tax, or'
                    .' leave the destination empty to remove the tax entirely.',
            ]);
        }

        // The unique index covers (position, src, dest), so a second row for the same source with a
        // *different* destination would be accepted by the database and then read as ambiguous by
        // the mapper — one source has one outcome.
        $clash = $fiscalPosition->taxMappings()
            ->where('tax_src_id', (int) $data['tax_src_id'])
            ->exists();

        if ($clash) {
            throw ValidationException::withMessages([
                'tax_src_id' => 'That tax is already mapped in this position. Remove the existing'
                    .' mapping first — one tax cannot become two different things at once.',
            ]);
        }

        $fiscalPosition->taxMappings()->create([
            'tax_src_id' => (int) $data['tax_src_id'],
            'tax_dest_id' => ($data['tax_dest_id'] ?? null) === null ? null : (int) $data['tax_dest_id'],
        ]);

        return back()->with('success', 'Tax mapping added.');
    }

    public function destroyMapping(FiscalPosition $fiscalPosition, FiscalPositionTax $mapping): RedirectResponse
    {
        Gate::authorize('update', $fiscalPosition);

        abort_unless((int) $mapping->fiscal_position_id === (int) $fiscalPosition->getKey(), 404);

        $mapping->delete();

        return back()->with('success', 'Tax mapping removed.');
    }

    /** @return array<string, mixed> */
    private function rules(bool $creating = true): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:96'],
            // Auto-apply is what makes a position fire without the cashier choosing it, so the
            // country and postcode range below are the rule it fires on.
            'auto_apply' => ['sometimes', 'boolean'],
            'country_id' => ['sometimes', 'nullable', 'integer', Rule::exists('countries', 'id')],
            'zip_from' => ['sometimes', 'nullable', 'string', 'max:24'],
            'zip_to' => ['sometimes', 'nullable', 'string', 'max:24'],
            'vat_required' => ['sometimes', 'boolean'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    /**
     * A tax of the acting company.
     *
     * Through the scoped model rather than `Rule::exists`: `taxes` carries a `company_id`, and
     * `Rule::exists` runs on the query builder — the one place `CompanyScope` cannot reach.
     */
    private function ownedTax(): callable
    {
        return static function (string $attribute, mixed $value, callable $fail): void {
            if ($value === null) {
                return;
            }

            if (! Tax::query()->whereKey((int) $value)->exists()) {
                $fail('That tax belongs to another venue, or no longer exists.');
            }
        };
    }
}
