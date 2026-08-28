<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\ComboItemRequest;
use App\Http\Requests\Backoffice\ComboRequest;
use App\Models\Catalog\Combo;
use App\Models\Catalog\ComboItem;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Set menus and their courses (BOF-088, BAN-416).
 *
 * A `combos` row is one **course** — "Starters", "Mains" — and the menu itself is a product with
 * those courses attached through `combo_product`. The register has known how to sell one since it
 * was written and the price distributor exists on both sides; there was no way to build one. A
 * formule could only be created by seeder or by SQL.
 *
 * ## `products.combo_count` is the whole of it
 *
 * `Product::requiresConfigurator()` reads `combo_count > 0`, and that is what makes the till stop
 * and ask the customer to choose. Nothing but the seeder has ever written it.
 *
 * So attaching a course to a menu **must** bump it. Without that the product is sold as an ordinary
 * item at its own price: the customer is charged for the menu, chooses nothing, and the kitchen
 * receives a ticket for a set menu with no dishes on it. The screen would look completely correct —
 * the courses are attached and visible here — which is why this is done in one transaction with the
 * pivot rather than left to a later recount.
 */
final class ComboController extends Controller
{
    public function index(): Response
    {
        Gate::authorize('viewAny', Combo::class);

        return Inertia::render('Combos/Index', [
            'combos' => Combo::query()
                ->withCount('items')
                ->with('products:id,name')
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(static fn (Combo $c): array => [
                    'id' => (int) $c->getKey(),
                    'name' => (string) $c->name,
                    'base_price' => (string) $c->base_price,
                    'qty_free' => (int) $c->qty_free,
                    'qty_max' => (int) $c->qty_max,
                    'sequence' => (int) $c->sequence,
                    'active' => (bool) $c->active,
                    'item_count' => (int) $c->items_count,
                    'menus' => $c->products->map(static fn (Product $p): array => [
                        'id' => (int) $p->getKey(),
                        'name' => (string) $p->name,
                    ])->values()->all(),
                ])->values()->all(),
        ]);
    }

    public function edit(Combo $combo): Response
    {
        Gate::authorize('view', $combo);

        return Inertia::render('Combos/Edit', [
            'combo' => $combo->attributesToArray(),
            'items' => $combo->items()
                ->with('variant:id,product_id,display_name,list_price')
                ->get()
                ->map(static fn (ComboItem $i): array => [
                    'id' => (int) $i->getKey(),
                    'product_variant_id' => (int) $i->product_variant_id,
                    'name' => (string) ($i->variant?->display_name ?? '—'),
                    // `list_price` is nullable on a variant and falls back to the product's; the
                    // accessor is what the till reads, so the picker shows the same number.
                    'list_price' => (string) ($i->variant?->effectivePrice() ?? '0'),
                    'extra_price' => (string) $i->extra_price,
                    'sequence' => (int) $i->sequence,
                    'active' => (bool) $i->active,
                ])->values()->all(),
            // What a course can be filled with, and which menus it belongs to.
            'variants' => ProductVariant::query()
                ->with('product:id,list_price')
                ->orderBy('display_name')
                ->get(['id', 'product_id', 'display_name', 'list_price', 'price_extra'])
                ->map(static fn (ProductVariant $v): array => [
                    'id' => (int) $v->getKey(),
                    'name' => (string) $v->display_name,
                    'list_price' => $v->effectivePrice(),
                ])->values()->all(),
            'menus' => $combo->products()->get(['products.id', 'products.name'])
                ->map(static fn (Product $p): array => [
                    'id' => (int) $p->getKey(),
                    'name' => (string) $p->name,
                ])->values()->all(),
            'products' => Product::query()
                ->where('available_in_pos', true)
                ->orderBy('name')
                ->get(['id', 'name'])
                ->all(),
        ]);
    }

    public function store(ComboRequest $request): RedirectResponse
    {
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a course.',
            ]);
        }

        $combo = Combo::query()->create([...$request->validated(), 'company_id' => $companyId]);

        return redirect()
            ->route('combos.edit', $combo->getKey())
            ->with('success', 'Course added. Its dishes are below.');
    }

    public function update(ComboRequest $request, Combo $combo): RedirectResponse
    {
        $combo->forceFill($request->validated())->save();

        return back()->with('success', 'Course saved.');
    }

    /**
     * Refused while a menu still offers it, or an order still names it.
     *
     * `combo_items.product_variant_id` is `restrictOnDelete` and `pos_order_lines` records which
     * combo a child line came from, so removing a course that has been sold would break the record
     * of what the customer actually chose.
     */
    public function destroy(Combo $combo): RedirectResponse
    {
        Gate::authorize('delete', $combo);

        $menus = $combo->products()->count();

        if ($menus > 0) {
            throw ValidationException::withMessages([
                'combo' => 'This course is part of '.$menus.' menu(s). Remove it from those first —'
                    .' a menu that loses a course silently stops asking for it.',
            ]);
        }

        $sold = DB::table('pos_order_lines')->where('combo_id', $combo->getKey())->count();

        if ($sold > 0) {
            throw ValidationException::withMessages([
                'combo' => 'This course has been sold on '.$sold.' order line(s), which record what'
                    .' the customer chose. Deactivate it instead.',
            ]);
        }

        $combo->delete();

        return back()->with('success', 'Course removed.');
    }

    public function storeItem(ComboItemRequest $request, Combo $combo): RedirectResponse
    {
        $data = $request->validated();

        $combo->items()->create([
            ...$data,
            'sequence' => $data['sequence'] ?? ((int) $combo->items()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Dish added to the course.');
    }

    public function updateItem(ComboItemRequest $request, Combo $combo, ComboItem $item): RedirectResponse
    {
        $this->refuseForeignItem($combo, $item);

        $item->forceFill($request->validated())->save();

        return back()->with('success', 'Dish saved.');
    }

    public function destroyItem(Combo $combo, ComboItem $item): RedirectResponse
    {
        Gate::authorize('update', $combo);
        $this->refuseForeignItem($combo, $item);

        $item->delete();

        return back()->with('success', 'Dish removed from the course.');
    }

    /**
     * `POST /combos/{combo}/menus` — this course becomes part of a menu.
     *
     * The pivot and `products.combo_count` move together, in one transaction. See the class docblock:
     * the count is what makes the till ask the customer to choose, and a menu with courses attached
     * and a count of zero is sold as an ordinary product — charged in full, chosen not at all.
     */
    public function attachMenu(Request $request, Combo $combo): RedirectResponse
    {
        Gate::authorize('update', $combo);

        $product = $this->ownedProduct($request);

        if ($combo->products()->whereKey($product->getKey())->exists()) {
            throw ValidationException::withMessages([
                'product_id' => 'This menu already offers this course.',
            ]);
        }

        DB::transaction(function () use ($combo, $product): void {
            $combo->products()->attach($product->getKey(), [
                'sequence' => (int) $combo->sequence,
            ]);

            $this->recountCombos($product);
        });

        return back()->with('success', 'Course added to the menu.');
    }

    public function detachMenu(Request $request, Combo $combo): RedirectResponse
    {
        Gate::authorize('update', $combo);

        $product = $this->ownedProduct($request);

        DB::transaction(function () use ($combo, $product): void {
            $combo->products()->detach($product->getKey());

            $this->recountCombos($product);
        });

        return back()->with('success', 'Course removed from the menu.');
    }

    /**
     * Restate `products.combo_count` from the pivot.
     *
     * Counted rather than incremented: an increment carries over any drift already there, and this
     * column has been written by the seeder alone since the schema was created, so drift is the
     * expected state rather than the surprising one.
     */
    private function recountCombos(Product $product): void
    {
        $product->forceFill([
            'combo_count' => DB::table('combo_product')
                ->where('product_id', $product->getKey())
                ->count(),
        ])->save();
    }

    /** Through the scoped model: `Rule::exists` would accept another venue's product. */
    private function ownedProduct(Request $request): Product
    {
        $data = $request->validate(['product_id' => ['required', 'integer']]);

        $product = Product::query()->whereKey((int) $data['product_id'])->first();

        if ($product === null) {
            throw ValidationException::withMessages([
                'product_id' => 'That menu belongs to another venue, or no longer exists.',
            ]);
        }

        return $product;
    }

    private function refuseForeignItem(Combo $combo, ComboItem $item): void
    {
        abort_unless((int) $item->combo_id === (int) $combo->getKey(), 404);
    }
}
