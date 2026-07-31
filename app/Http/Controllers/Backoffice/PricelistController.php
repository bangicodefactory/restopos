<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pricing\Pricelist;
use App\Models\Pricing\PricelistItem;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Pricelists/Index` and `Pricelists/Edit` (spec 02 BOF-090…BOF-099).
 *
 * Rules are resolved by specificity — variant, then product, then the category
 * tree walked upward, then global — and the editor must make that ranking
 * visible, because "why is this price not applying" is the single most common
 * support question about pricelists.
 */
final class PricelistController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('Pricelists/Index', [
            'pricelists' => Pricelist::query()->withCount('items')->orderBy('name')->get()
                ->map(static fn (Pricelist $p): array => [
                    'id' => (int) $p->getKey(),
                    'name' => (string) $p->name,
                    'currency_id' => (int) $p->currency_id,
                    'sequence' => (int) $p->sequence,
                    'active' => (bool) $p->active,
                    'item_count' => (int) $p->items_count,
                ])->values()->all(),
        ]);
    }

    public function edit(Pricelist $pricelist): Response
    {
        return Inertia::render('Pricelists/Edit', [
            'pricelist' => $pricelist->attributesToArray(),
            'items' => PricelistItem::query()
                ->where('pricelist_id', $pricelist->getKey())
                ->orderBy('sequence')
                ->get()
                ->map(static fn (PricelistItem $i): array => $i->attributesToArray())
                ->values()
                ->all(),
        ]);
    }

    public function update(Request $request, Pricelist $pricelist): RedirectResponse
    {
        $pricelist->forceFill($request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            'currency_id' => ['sometimes', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]))->save();

        return back()->with('success', 'Pricelist saved.');
    }
}
