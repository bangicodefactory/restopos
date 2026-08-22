<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pricing\TaxGroup;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * Tax groups (BOF-091, BAN-396) — the heading a tax totals under.
 *
 * Two taxes in one group print as a single line on the receipt and total as a single row on the
 * session's tax summary. That is the whole of what a group does, and it is why this exists at all:
 * `taxes.tax_group_id` is a `restrictOnDelete` foreign key with `required` on create, so a venue
 * that could not make a group could not make a tax either. Adding a tax was reachable only for
 * whatever groups the seeder happened to leave behind.
 *
 * Listed on `Taxes/Index` rather than getting a screen of its own: a group has three fields and only
 * ever exists to be pointed at from the tax editor two panels away.
 */
final class TaxGroupController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', TaxGroup::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a tax group.']);
        }

        TaxGroup::query()->create([
            ...$data,
            'company_id' => $companyId,
            'sequence' => $data['sequence'] ?? ((int) TaxGroup::query()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Tax group added.');
    }

    public function update(Request $request, TaxGroup $taxGroup): RedirectResponse
    {
        Gate::authorize('update', $taxGroup);

        // No arithmetic freeze here, unlike `TaxController::update`. A group carries no rate: renaming
        // it changes the heading the next receipt prints and nothing a rung-up line computed.
        $taxGroup->forceFill($this->validated($request, creating: false))->save();

        return back()->with('success', 'Tax group saved.');
    }

    /**
     * `DELETE /tax-groups/{taxGroup}` — remove a grouping (BOF-091).
     *
     * Both referents are `restrictOnDelete`, so without these checks the database refuses too — as a
     * SQLSTATE 23000 reaching a manager as a 500 that names nothing.
     *
     * A group quoted by a closed session's tax summary can never be removed by anyone: those figures
     * are frozen at close and the group is the heading they are read under. There is no "deactivate"
     * fallback here — a group has no `active` column — so the honest answer is to leave it, empty, in
     * the list.
     */
    public function destroy(Request $request, TaxGroup $taxGroup): RedirectResponse
    {
        Gate::authorize('delete', $taxGroup);

        $reported = $this->connection->table('session_tax_summaries')
            ->where('tax_group_id', $taxGroup->getKey())
            ->count();

        if ($reported > 0) {
            throw ValidationException::withMessages([
                'group' => 'This group appears on '.$reported.' closed session report(s) and cannot be'
                    .' removed. Move its taxes to another group and leave it empty.',
            ]);
        }

        $taxes = $this->connection->table('taxes')
            ->where('tax_group_id', $taxGroup->getKey())
            ->count();

        if ($taxes > 0) {
            throw ValidationException::withMessages([
                'group' => 'This group still holds '.$taxes.' tax(es). Move them to another group first.',
            ]);
        }

        $taxGroup->delete();

        return back()->with('success', 'Tax group removed.');
    }

    /** @return array<string, mixed> */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return $request->validate([
            'name' => [$required, 'string', 'max:64'],
            // What the customer reads. Falls back to `name` when blank — see `TaxGroup::receiptLabel()`
            // — so a group can be called "Reduced rate — food" internally and print as "VAT 6%".
            'receipt_label' => ['sometimes', 'nullable', 'string', 'max:64'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
        ]);
    }
}
