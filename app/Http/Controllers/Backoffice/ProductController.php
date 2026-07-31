<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Pricing\Tax;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Products/Index` and `Products/Edit` — the menu (spec 02 BOF-080…BOF-109).
 *
 * The list is paginated server-side and consumed by Inertia's `WhenVisible`
 * infinite scroll; a catalog of 20 000 items must never be one JSON blob.
 */
final class ProductController extends Controller
{
    public function index(Request $request): Response
    {
        $request->validate([
            'search' => ['nullable', 'string', 'max:120'],
            'category_id' => ['nullable', 'integer'],
        ]);

        $products = Product::query()
            ->with(['posCategories:id,name'])
            ->when($request->query('search'), fn ($q, $s) => $q->where(fn ($i) => $i
                ->where('name', 'like', '%'.$s.'%')
                ->orWhere('default_code', 'like', '%'.$s.'%')
                ->orWhere('barcode', 'like', '%'.$s.'%')))
            ->when($request->query('category_id'), fn ($q, $c) => $q->whereHas('posCategories', fn ($i) => $i->whereKey((int) $c)))
            ->orderBy('name')
            ->paginate(50)
            ->withQueryString();

        return Inertia::render('Products/Index', [
            'products' => $products->through(static fn (Product $p): array => [
                'id' => (int) $p->getKey(),
                'name' => (string) $p->name,
                'default_code' => $p->default_code,
                'barcode' => $p->barcode,
                'list_price' => (string) $p->list_price,
                'standard_price' => (string) $p->standard_price,
                'available_in_pos' => (bool) $p->available_in_pos,
                'self_order_available' => (bool) $p->self_order_available,
                'active' => (bool) $p->active,
                'categories' => $p->posCategories->pluck('name')->all(),
            ]),
            'filters' => $request->only(['search', 'category_id']),
            'categories' => Inertia::defer(fn (): array => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all()),
        ]);
    }

    public function edit(Product $product): Response
    {
        $product->load(['variants', 'posCategories:id,name', 'taxes:id,name,amount']);

        return Inertia::render('Products/Edit', [
            'product' => $product->attributesToArray() + [
                'pos_category_ids' => $product->posCategories->pluck('id')->all(),
                'tax_ids' => $product->taxes->pluck('id')->all(),
                'variants' => $product->variants->map(static fn ($v): array => $v->attributesToArray())->all(),
            ],
            'options' => Inertia::defer(fn (): array => [
                'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all(),
                'taxes' => Tax::query()->where('active', true)->orderBy('sequence')->get(['id', 'name', 'amount', 'amount_type'])->all(),
            ]),
        ]);
    }

    public function update(Request $request, Product $product): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:200'],
            'default_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'barcode' => ['sometimes', 'nullable', 'string', 'max:64'],
            'list_price' => ['sometimes', 'numeric'],
            'standard_price' => ['sometimes', 'numeric'],
            'available_in_pos' => ['sometimes', 'boolean'],
            'self_order_available' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
            'pos_category_ids' => ['sometimes', 'array'],
            'tax_ids' => ['sometimes', 'array'],
        ]);

        if (array_key_exists('pos_category_ids', $data)) {
            $product->posCategories()->sync(array_map(intval(...), (array) $data['pos_category_ids']));
            unset($data['pos_category_ids']);
        }

        if (array_key_exists('tax_ids', $data)) {
            $product->taxes()->sync(array_map(intval(...), (array) $data['tax_ids']));
            unset($data['tax_ids']);
        }

        $product->forceFill($data)->save();

        return back()->with('success', 'Product saved.');
    }
}
