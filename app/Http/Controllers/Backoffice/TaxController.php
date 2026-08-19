<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\TaxAmountType;
use App\Enums\TaxRoundingStrategy;
use App\Http\Controllers\Controller;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Taxes/Index` (spec 02 BOF-091).
 *
 * `include_base_amount` compounds forward and `is_base_affected` compounds
 * backward; the two are independent and both load-bearing, so the editor shows
 * them as separate switches rather than one "compound" checkbox.
 */
final class TaxController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', Tax::class);

        return Inertia::render('Taxes/Index', [
            'taxes' => Tax::query()->orderBy('sequence')->get()->map(static fn (Tax $t): array => [
                'id' => (int) $t->getKey(),
                'name' => (string) $t->name,
                'description' => $t->description,
                'tax_group_id' => (int) $t->tax_group_id,
                'amount_type' => (string) ($t->amount_type?->value ?? $t->amount_type),
                'amount' => (string) $t->amount,
                'price_include' => (bool) $t->price_include,
                'include_base_amount' => (bool) $t->include_base_amount,
                'is_base_affected' => (bool) $t->is_base_affected,
                'has_negative_factor' => (bool) $t->has_negative_factor,
                'sequence' => (int) $t->sequence,
                'rounding_strategy' => (string) ($t->rounding_strategy?->value ?? $t->rounding_strategy),
                'active' => (bool) $t->active,
            ])->values()->all(),
            'groups' => TaxGroup::query()->orderBy('sequence')->get(['id', 'name', 'receipt_label'])->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', Tax::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a tax.']);
        }

        Tax::query()->create([
            ...$data,
            'company_id' => $companyId,
            'sequence' => $data['sequence'] ?? ((int) Tax::query()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Tax added.');
    }

    public function update(Request $request, Tax $tax): RedirectResponse
    {
        Gate::authorize('update', $tax);

        $tax->forceFill($this->validated($request, creating: false))->save();

        return back()->with('success', 'Tax saved.');
    }

    /**
     * `DELETE /taxes/{tax}` — remove a tax (BOF-091).
     *
     * Refused while anything still points at it, and the refusal names what.
     *
     * `product_tax`, `product_variant_tax` and `session_tax_summaries` all hold `restrictOnDelete`,
     * so without this the database refuses too — as a SQLSTATE 23000 surfacing to a manager as a 500
     * with no clue which product is in the way. The rule is the same either way; only one of the two
     * can be acted on.
     *
     * The summaries matter most and are the least obvious: they are a closed session's frozen tax
     * figures. A tax that has ever appeared on a Z-report cannot be deleted at all, because the
     * report would lose the row that explains its own total. **Deactivate** it instead — `active`
     * takes it out of every picker and leaves history intact, which is what "removing" a tax almost
     * always means.
     */
    public function destroy(Request $request, Tax $tax): RedirectResponse
    {
        Gate::authorize('delete', $tax);

        $products = $this->connection->table('product_tax')->where('tax_id', $tax->getKey())->count();
        $variants = $this->connection->table('product_variant_tax')->where('tax_id', $tax->getKey())->count();
        $reported = $this->connection->table('session_tax_summaries')->where('tax_id', $tax->getKey())->count();

        if ($reported > 0) {
            throw ValidationException::withMessages([
                'tax' => 'This tax appears on '.$reported.' closed session report(s) and cannot be removed.'
                    .' Deactivate it instead — it will disappear from the tills and the reports stay intact.',
            ]);
        }

        if ($products > 0 || $variants > 0) {
            throw ValidationException::withMessages([
                'tax' => 'This tax is still applied to '.($products + $variants).' product(s).'
                    .' Take it off them first, or deactivate it.',
            ]);
        }

        $tax->delete();

        return back()->with('success', 'Tax removed.');
    }

    /**
     * The whole rule set, including the four fields the tax engine actually branches on.
     *
     * `amount_type`, `tax_group_id`, `has_negative_factor` and `rounding_strategy` were all absent
     * before (BAN-396). Between them they decide whether a tax is a percentage or a fixed sum, which
     * group it totals under on a receipt, whether it subtracts rather than adds, and how it rounds —
     * so the only fields a seeded tax could not change were the ones that decide what it computes.
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:96'],
            'description' => ['sometimes', 'nullable', 'string', 'max:64'],

            // Percentage, fixed amount, group or division — the engine computes a different thing
            // for each, so an unknown value is not a validation nicety.
            'amount_type' => [$required, Rule::enum(TaxAmountType::class)],
            'amount' => [$required, 'numeric'],

            // Shape here; **ownership** is resolved through the scoped model below. The rule form
            // — `Rule::exists(...)->where('company_id', ActingCompany::id())` — cannot express it:
            // the scope answers `UNRESTRICTED` for a super-admin, so the comparison matches nothing
            // and the one account that may act across companies is the one that cannot set a group.
            'tax_group_id' => [$required, 'integer'],

            'price_include' => ['sometimes', 'boolean'],
            // These two are independent and both load-bearing: one compounds forward, the other
            // backward.
            'include_base_amount' => ['sometimes', 'boolean'],
            'is_base_affected' => ['sometimes', 'boolean'],
            // A withholding-style line that subtracts rather than adds.
            'has_negative_factor' => ['sometimes', 'boolean'],
            'rounding_strategy' => ['sometimes', Rule::enum(TaxRoundingStrategy::class)],

            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        // The group is what a receipt totals under, so another tenant's would put this venue's VAT
        // beneath a heading it does not own. Resolved through the scoped model, which answers
        // correctly for a super-admin as well.
        if (array_key_exists('tax_group_id', $data)
            && ! TaxGroup::query()->whereKey((int) $data['tax_group_id'])->exists()) {
            throw ValidationException::withMessages(['tax_group_id' => 'No such tax group.']);
        }

        return $data;
    }
}
