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

        // `nullable` leaves the key absent when the field is not submitted at all, so read it
        // defensively — indexing it directly 500s on a top-level category.
        $parentId = $data['parent_id'] ?? null;
        $parent = $parentId === null ? null : PosCategory::query()->find($parentId);

        // `exists:pos_categories,id` runs unscoped, so it passes for another tenant's category while
        // the scoped `find()` above returns null. Silently rooting the category would move it between
        // companies; say so instead (XCT-101).
        if ($parentId !== null && $parent === null) {
            return back()->with('error', 'That parent category no longer exists.');
        }

        // The tenant comes from who is signed in, never from a default. `?? 1` put every company's
        // top-level categories into company 1, where the creator could no longer see them.
        $companyId = $parent?->company_id ?? $request->user()?->getAttribute('company_id');

        if ($companyId === null) {
            return back()->with('error', 'Your account is not attached to a company, so it cannot create categories.');
        }

        PosCategory::query()->create([
            ...$data,
            'company_id' => (int) $companyId,
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
