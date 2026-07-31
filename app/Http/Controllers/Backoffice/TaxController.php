<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Taxes/Index` (spec 02 BOF-100…BOF-109).
 *
 * `include_base_amount` compounds forward and `is_base_affected` compounds
 * backward; the two are independent and both load-bearing, so the editor shows
 * them as separate switches rather than one "compound" checkbox.
 */
final class TaxController extends Controller
{
    public function index(): Response
    {
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

    public function update(Request $request, Tax $tax): RedirectResponse
    {
        $tax->forceFill($request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            'description' => ['sometimes', 'nullable', 'string', 'max:64'],
            'amount' => ['sometimes', 'numeric'],
            'price_include' => ['sometimes', 'boolean'],
            'include_base_amount' => ['sometimes', 'boolean'],
            'is_base_affected' => ['sometimes', 'boolean'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]))->save();

        return back()->with('success', 'Tax saved.');
    }
}
