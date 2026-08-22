<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Services\Catalog\CategoryTree;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Categories/Index` — POS categories, their tree and the time windows that
 * hide them from the self-order menu outside service hours (BOF-084, BOF-085).
 *
 * `store` and `update` share one rule set (BAN-422). They did not, and the split was not a
 * simplification but two different absent capabilities: a category could not be given an
 * availability window at creation, and could **never** be moved to another parent afterwards.
 * Moving one meant delete-and-recreate — which, given every referent cascades, threw away its
 * products, its printer routing and its pricelist rules on the way.
 */
final class CategoryController extends Controller
{
    public function __construct(
        private readonly CategoryTree $tree,
        private readonly ConnectionInterface $connection,
    ) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', PosCategory::class);

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
        Gate::authorize('create', PosCategory::class);

        $data = $this->validated($request, creating: true);
        $parent = $this->ownedParent($data['parent_id'] ?? null);

        // The tenant comes from the parent, or from who is signed in — never from a default. `?? 1`
        // put every company's top-level categories into company 1, where the creator could no longer
        // see them.
        $companyId = $parent?->company_id ?? ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Your account is not attached to a company, so it cannot create categories.',
            ]);
        }

        $this->connection->transaction(function () use ($data, $companyId, $parent): void {
            /** @var PosCategory $category */
            $category = PosCategory::query()->create([
                ...$data,
                'company_id' => $companyId,
                // Placeholder: the real path contains this row's own id, which does not exist yet.
                'depth' => 0,
                'path' => '/',
            ]);

            $this->tree->place($category, $parent);
        });

        return back()->with('success', 'Category created.');
    }

    public function update(Request $request, PosCategory $category): RedirectResponse
    {
        Gate::authorize('update', $category);

        $data = $this->validated($request, creating: false);

        $this->connection->transaction(function () use ($data, $category): void {
            $moving = array_key_exists('parent_id', $data);
            $parent = $moving ? $this->ownedParent($data['parent_id']) : null;

            unset($data['parent_id']);

            $category->forceFill($data)->save();

            if ($moving && (int) ($parent?->getKey() ?? 0) !== (int) ($category->parent_id ?? 0)) {
                $category->forceFill(['parent_id' => $parent?->getKey()])->save();
                $this->tree->reparent($category, $parent);
            }
        });

        return back()->with('success', 'Category saved.');
    }

    /**
     * `DELETE /categories/{category}` — remove a category (BOF-084).
     *
     * Guarded, and this is the sharpest delete in the back office because **every referent cascades**:
     * `parent_id`, `pos_category_product`, `pos_category_pos_printer`, `pos_config_pos_category` and
     * the pricelist item's `pos_category_id` are all `cascadeOnDelete`. So an unguarded delete of one
     * category silently takes its whole subtree, drops every product off the menu, unroutes the
     * kitchen printers those products were sent to, removes the category from the registers showing
     * it, and deletes the pricelist rules keyed to it — reporting success the entire way.
     *
     * The database will not stop any of it. Only this will.
     */
    public function destroy(Request $request, PosCategory $category): RedirectResponse
    {
        Gate::authorize('delete', $category);

        $children = PosCategory::query()->where('parent_id', $category->getKey())->count();

        if ($children > 0) {
            throw ValidationException::withMessages([
                'category' => 'This category has '.$children.' sub-categor(ies) and they would be deleted'
                    .' with it. Move or remove them first.',
            ]);
        }

        // Counted per referent so the message names what is actually in the way — "6 products" is
        // actionable, "it is in use" is not.
        $blocking = [];

        foreach ([
            'pos_category_product' => 'product(s)',
            'pos_category_pos_printer' => 'kitchen printer route(s)',
            'pos_config_pos_category' => 'register(s)',
            'pricelist_items' => 'pricelist rule(s)',
        ] as $table => $label) {
            $count = $this->connection->table($table)
                ->where('pos_category_id', $category->getKey())
                ->count();

            if ($count > 0) {
                $blocking[] = $count.' '.$label;
            }
        }

        if ($blocking !== []) {
            throw ValidationException::withMessages([
                'category' => 'This category is still used by '.implode(', ', $blocking).'.'
                    .' Deactivate it instead — it disappears from the tills and everything pointing'
                    .' at it stays intact.',
            ]);
        }

        $category->delete();

        return back()->with('success', 'Category deleted.');
    }

    /**
     * Resolve a submitted parent through the scoped model.
     *
     * `exists:pos_categories,id` runs unscoped, so it passes for another tenant's category while the
     * scoped lookup returns null — and silently rooting the node instead would move it between
     * companies (XCT-101). Refused by name rather than quietly re-rooted.
     */
    private function ownedParent(mixed $parentId): ?PosCategory
    {
        if ($parentId === null || $parentId === '') {
            return null;
        }

        $parent = PosCategory::query()->find((int) $parentId);

        if ($parent === null) {
            throw ValidationException::withMessages([
                'parent_id' => 'That parent category no longer exists.',
            ]);
        }

        return $parent;
    }

    /**
     * One rule set for both doors (BAN-422).
     *
     * `hour_after` / `hour_until` were accepted only on update and `parent_id` only on create, so
     * each form was missing a capability the other had — and the two pages mirrored the split
     * exactly, which is what made it look deliberate.
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return $request->validate([
            'name' => [$required, 'string', 'max:96'],
            'parent_id' => ['sometimes', 'nullable', 'integer'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'color' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:255'],
            // The self-order availability window, in hours past midnight. The table carries a check
            // constraint that `hour_until >= hour_after`, so an inverted window is a 500 unless it is
            // caught here.
            'hour_after' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:24'],
            'hour_until' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:24', 'gte:hour_after'],
            'self_order_visible' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
        ]);
    }
}
