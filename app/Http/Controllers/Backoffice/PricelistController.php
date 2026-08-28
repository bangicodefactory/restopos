<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\PricelistItemRequest;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Pricelist;
use App\Models\Pricing\PricelistItem;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
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
        Gate::authorize('viewAny', Pricelist::class);

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
            // A price list could be edited but never created, so nothing here had to offer a
            // currency to price in (BAN-401). Currencies are global ISO reference data.
            'currencies' => Currency::query()->orderBy('code')->get(['id', 'name', 'code'])->all(),
        ]);
    }

    public function edit(Pricelist $pricelist): Response
    {
        Gate::authorize('view', $pricelist);

        return Inertia::render('Pricelists/Edit', [
            'pricelist' => $pricelist->attributesToArray(),
            'items' => PricelistItem::query()
                ->where('pricelist_id', $pricelist->getKey())
                ->orderBy('sequence')
                ->get()
                ->map(static fn (PricelistItem $i): array => $i->attributesToArray())
                ->values()
                ->all(),
            // The rule editor needs something to point a rule at. `edit()` sent neither, so a
            // product- or category-scoped rule would have rendered an empty picker (BAN-401).
            'products' => Product::query()
                ->where('available_in_pos', true)
                ->orderBy('name')
                ->get(['id', 'name'])
                ->all(),
            'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name'])->all(),
        ]);
    }

    public function update(Request $request, Pricelist $pricelist): RedirectResponse
    {
        Gate::authorize('update', $pricelist);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            // Currencies are global ISO reference data with no `company_id`, so an unscoped `exists`
            // is the honest rule here.
            'currency_id' => ['sometimes', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $this->assertCurrencyStillFitsItsRegisters($pricelist, $data);

        $pricelist->forceFill($data)->save();

        return back()->with('success', 'Pricelist saved.');
    }

    /**
     * `POST /pricelists` — a new price list (BOF-037).
     *
     * "Change a price rule" is the most common back-office task in a restaurant, and there was no
     * endpoint for it at all: the header could be edited, the rules were a read-only explorer, and
     * a price list could not be created or removed. Happy hour, a member rate, a category markdown
     * — none of it could be set up through the UI.
     */
    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', Pricelist::class);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:96'],
            'currency_id' => ['required', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
        ]);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a price list.',
            ]);
        }

        $pricelist = Pricelist::query()->create([...$data, 'company_id' => $companyId]);

        return redirect()
            ->route('pricelists.edit', $pricelist->getKey())
            ->with('success', 'Price list added. Its rules are below.');
    }

    /**
     * Refused while anything still prices from it.
     *
     * `pos_configs.pricelist_id`, the `pos_config_pricelist` pivot, `customers.pricelist_id`,
     * `pricelist_items.base_pricelist_id` and every order that recorded which list it was priced
     * against. The last is the one that matters most: an order names the list so the price it
     * charged can be explained afterwards.
     */
    public function destroy(Pricelist $pricelist): RedirectResponse
    {
        Gate::authorize('delete', $pricelist);

        $orders = Order::query()->where('pricelist_id', $pricelist->getKey())->count();

        if ($orders > 0) {
            throw ValidationException::withMessages([
                'pricelist' => 'This price list priced '.$orders.' order(s) and cannot be removed.'
                    .' Deactivate it instead — it stops being offered and every past order keeps'
                    .' saying what it was priced against.',
            ]);
        }

        $registers = PosConfig::query()->where('pricelist_id', $pricelist->getKey())->count();

        if ($registers > 0) {
            throw ValidationException::withMessages([
                'pricelist' => 'This price list is the default on '.$registers.' register(s). Point'
                    .' them at another one first.',
            ]);
        }

        $derived = PricelistItem::query()->where('base_pricelist_id', $pricelist->getKey())->count();

        if ($derived > 0) {
            throw ValidationException::withMessages([
                'pricelist' => $derived.' rule(s) on other price lists compute their prices from this'
                    .' one. Change those first, or their prices would quietly fall back to the'
                    .' product price.',
            ]);
        }

        $pricelist->delete();

        return back()->with('success', 'Price list removed.');
    }

    public function storeItem(PricelistItemRequest $request, Pricelist $pricelist): RedirectResponse
    {
        $data = $request->validated();

        $pricelist->items()->create([
            ...$data,
            'company_id' => $pricelist->company_id,
            'sequence' => $data['sequence'] ?? ((int) $pricelist->items()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Price rule added.');
    }

    public function updateItem(PricelistItemRequest $request, Pricelist $pricelist, PricelistItem $item): RedirectResponse
    {
        $this->refuseForeignItem($pricelist, $item);

        $item->forceFill($request->validated())->save();

        return back()->with('success', 'Price rule saved.');
    }

    public function destroyItem(Pricelist $pricelist, PricelistItem $item): RedirectResponse
    {
        Gate::authorize('update', $pricelist);
        $this->refuseForeignItem($pricelist, $item);

        $item->delete();

        return back()->with('success', 'Price rule removed.');
    }

    /**
     * A price list prices in one currency, and its registers quote in theirs.
     *
     * BAN-466 refuses attaching a pricelist whose currency disagrees with the register. This is the
     * same rule approached from the other side: re-currencying a list already attached to a register
     * would create exactly the inconsistency that check exists to prevent, and nothing converts —
     * `PricingService` reads the item amount as-is, so the till would quote these numbers under the
     * wrong symbol.
     *
     * @param  array<string, mixed>  $data
     */
    private function assertCurrencyStillFitsItsRegisters(Pricelist $pricelist, array $data): void
    {
        if (! array_key_exists('currency_id', $data)) {
            return;
        }

        $currencyId = (int) $data['currency_id'];

        if ($currencyId === (int) $pricelist->currency_id) {
            return;
        }

        $clashing = PosConfig::query()
            ->where('currency_id', '!=', $currencyId)
            ->where(function ($query) use ($pricelist): void {
                $query->where('pricelist_id', $pricelist->getKey())
                    ->orWhereHas('pricelists', fn ($q) => $q->whereKey($pricelist->getKey()));
            })
            ->count();

        if ($clashing > 0) {
            throw ValidationException::withMessages([
                'currency_id' => $clashing.' register(s) use this price list and quote in a different'
                    .' currency. Their tills would show these amounts under the wrong symbol —'
                    .' nothing converts. Detach it from those registers first.',
            ]);
        }
    }

    private function refuseForeignItem(Pricelist $pricelist, PricelistItem $item): void
    {
        abort_unless((int) $item->pricelist_id === (int) $pricelist->getKey(), 404);
    }
}
