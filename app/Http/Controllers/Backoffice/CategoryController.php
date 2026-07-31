<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Categories/Index` — POS categories, their tree and the time windows that
 * hide them from the self-order menu outside service hours (BOF-085).
 */
final class CategoryController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('Categories/Index', [
            'categories' => PosCategory::query()->orderBy('sequence')->get()->map(static fn (PosCategory $c): array => [
                'id' => (int) $c->getKey(),
                'name' => (string) $c->name,
                'parent_id' => $c->parent_id,
                'depth' => (int) $c->depth,
                'sequence' => (int) $c->sequence,
                'color' => (int) $c->color,
                'hour_after' => $c->hour_after,
                'hour_until' => $c->hour_until,
                'self_order_visible' => (bool) $c->self_order_visible,
                'active' => (bool) $c->active,
            ])->values()->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:96'],
            'parent_id' => ['nullable', 'integer', 'exists:pos_categories,id'],
            'sequence' => ['nullable', 'integer'],
            'color' => ['nullable', 'integer', 'min:0', 'max:255'],
            'self_order_visible' => ['nullable', 'boolean'],
        ]);

        $parent = $data['parent_id'] === null ? null : PosCategory::query()->find($data['parent_id']);

        PosCategory::query()->create([
            ...$data,
            'company_id' => $parent?->company_id ?? 1,
            'depth' => $parent === null ? 0 : (int) $parent->depth + 1,
            'path' => ($parent?->path ?? '').'/'.$data['name'],
        ]);

        return back()->with('success', 'Category created.');
    }

    public function update(Request $request, PosCategory $category): RedirectResponse
    {
        $category->forceFill($request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            'sequence' => ['sometimes', 'integer'],
            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'hour_after' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:24'],
            'hour_until' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:24'],
            'self_order_visible' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
        ]))->save();

        return back()->with('success', 'Category saved.');
    }

    public function destroy(PosCategory $category): RedirectResponse
    {
        $category->delete();

        return back()->with('success', 'Category deleted.');
    }
}
