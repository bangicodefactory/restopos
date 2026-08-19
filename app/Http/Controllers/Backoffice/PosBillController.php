<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\DenominationType;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosBill;
use App\Models\Pricing\Currency;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Coin and note denominations (BOF-111, BAN-483).
 *
 * `pos_bills` had a table and a model and no way to reach either, so the denominations were whatever
 * the seeder produced. That is not cosmetic: the register already reads these rows in two places —
 * the close-session count sheet a cashier tallies the drawer against, and the quick-tender keys on
 * the payment screen (REG-205). A venue trading in a currency the seeder did not anticipate counted
 * its drawer against the wrong notes and had no way to correct it.
 *
 * Both consumers are already wired; this is the surface that feeds them.
 */
final class PosBillController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('PosBills/Index', [
            'bills' => PosBill::query()
                ->orderBy('currency_id')
                ->orderBy('sequence')
                ->get(['id', 'currency_id', 'name', 'value', 'denomination_type', 'sequence', 'active'])
                ->map(static fn (PosBill $bill): array => [
                    'id' => (int) $bill->getKey(),
                    'currency_id' => (int) $bill->currency_id,
                    'name' => (string) $bill->name,
                    'value' => (string) $bill->value,
                    'denomination_type' => (string) ($bill->denomination_type?->value ?? $bill->denomination_type),
                    'sequence' => (int) $bill->sequence,
                    'active' => (bool) $bill->active,
                ])->values()->all(),
            'currencies' => Currency::query()->orderBy('name')->get(['id', 'name', 'symbol'])->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', PosBill::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a denomination.']);
        }

        PosBill::query()->create([
            ...$data,
            'company_id' => $companyId,
            'sequence' => $data['sequence'] ?? ((int) PosBill::query()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Denomination added.');
    }

    public function update(Request $request, PosBill $posBill): RedirectResponse
    {
        Gate::authorize('update', $posBill);

        $posBill->forceFill($this->validated($request, creating: false))->save();

        return back()->with('success', 'Denomination saved.');
    }

    /**
     * Denominations are reference data, not history: nothing points at a `pos_bills` row, so removing
     * one takes a key off the payment screen and a line off the count sheet and nothing else. No
     * guard is needed, and inventing one would only make a manager click twice.
     */
    public function destroy(Request $request, PosBill $posBill): RedirectResponse
    {
        Gate::authorize('delete', $posBill);

        $posBill->delete();

        return back()->with('success', 'Denomination removed.');
    }

    /** @return array<string, mixed> */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return $request->validate([
            'name' => [$required, 'string', 'max:32'],
            // The face value, and what the count sheet multiplies a tally by. Positive: a zero or
            // negative denomination silently contributes nothing to a drawer count that looks right.
            'value' => [$required, 'numeric', 'gt:0'],
            'denomination_type' => [$required, Rule::enum(DenominationType::class)],
            // Existence only, and deliberately **not** company-scoped: `currencies` is global
            // reference data — ISO codes, no `company_id` to scope by — unlike the ids BAN-520
            // guards. Saying otherwise here would be a comment describing a rule that cannot exist.
            //
            // A denomination in a currency this register does not trade in is harmless rather than
            // wrong: `PosBill::scopeForPos()` filters on the config's own `currency_id`, so it never
            // reaches the count sheet. A venue that runs two currencies can hold both lists.
            'currency_id' => [$required, 'integer', Rule::exists('currencies', 'id')],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);
    }
}
