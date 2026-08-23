<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\ProductCategory;
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
 * `ProductCategories/Index` — the accounting category tree (BAN-501).
 *
 * Distinct from `pos_categories`, which is what a cashier browses. This one exists to answer "which
 * revenue account does this sale post to": `ledger_code` is echoed into the `label` column of every
 * sales row in the accounting export (BAN-448).
 *
 * Until now it had no surface at all. `ledger_code` was settable by the seeder and by direct SQL and
 * by nothing else, so a real venue shipped an export whose label column was blank on every sales row
 * — the column BAN-448 was written to fill.
 *
 * The tree mechanics are `CategoryTree`, shared with the POS tree. The surfaces stay separate
 * because the two trees answer different questions and a manager editing one is not thinking about
 * the other.
 */
final class ProductCategoryController extends Controller
{
    public function __construct(
        private readonly CategoryTree $tree,
        private readonly ConnectionInterface $connection,
    ) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', ProductCategory::class);

        return Inertia::render('ProductCategories/Index', [
            'categories' => ProductCategory::query()
                ->withCount('products')
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(fn (ProductCategory $c): array => [
                    'id' => (int) $c->getKey(),
                    'name' => (string) $c->name,
                    'parent_id' => $c->parent_id,
                    'sequence' => (int) $c->sequence,
                    'ledger_code' => $c->ledger_code,
                    // Derived rather than stored: this table does not denormalise `depth`, and the
                    // page needs it only to indent.
                    'depth' => $this->tree->depthOf((string) $c->path),
                    'product_count' => (int) $c->products_count,
                ])->values()->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', ProductCategory::class);

        $data = $this->validated($request, creating: true);
        $parent = $this->ownedParent($data['parent_id'] ?? null);
        $companyId = $parent?->company_id ?? ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Your account is not attached to a company, so it cannot create categories.',
            ]);
        }

        $this->connection->transaction(function () use ($data, $companyId, $parent): void {
            /** @var ProductCategory $category */
            $category = ProductCategory::query()->create([
                ...$data,
                'company_id' => $companyId,
                // Placeholder: the real path contains this row's own id, which does not exist yet.
                'path' => '/',
            ]);

            $this->tree->place($category, $parent);
        });

        return back()->with('success', 'Product category created.');
    }

    public function update(Request $request, ProductCategory $productCategory): RedirectResponse
    {
        Gate::authorize('update', $productCategory);

        $data = $this->validated($request, creating: false);

        $this->connection->transaction(function () use ($data, $productCategory): void {
            $moving = array_key_exists('parent_id', $data);
            $parent = $moving ? $this->ownedParent($data['parent_id']) : null;

            unset($data['parent_id']);

            $productCategory->forceFill($data)->save();

            if ($moving && (int) ($parent?->getKey() ?? 0) !== (int) ($productCategory->parent_id ?? 0)) {
                $productCategory->forceFill(['parent_id' => $parent?->getKey()])->save();
                $this->tree->reparent($productCategory, $parent);
            }
        });

        return back()->with('success', 'Product category saved.');
    }

    /**
     * `DELETE /product-categories/{productCategory}` — remove a category (BAN-501).
     *
     * Refused while products are filed under it, and that is the whole point of the guard.
     * `products.product_category_id` is `nullOnDelete`, so the delete always succeeds: the products
     * survive, uncategorised, and their **ledger code silently becomes blank**. Nothing fails, no
     * report changes today, and the damage appears in the next accounting export as sales rows with
     * an empty revenue account — the exact condition BAN-448 was written to end.
     *
     * Sub-categories cascade, so they are refused too rather than taken along quietly.
     */
    public function destroy(Request $request, ProductCategory $productCategory): RedirectResponse
    {
        Gate::authorize('delete', $productCategory);

        $children = ProductCategory::query()->where('parent_id', $productCategory->getKey())->count();

        if ($children > 0) {
            throw ValidationException::withMessages([
                'category' => 'This category has '.$children.' sub-categor(ies) and they would be deleted'
                    .' with it. Move or remove them first.',
            ]);
        }

        $products = $this->connection->table('products')
            ->where('product_category_id', $productCategory->getKey())
            ->count();

        if ($products > 0) {
            throw ValidationException::withMessages([
                'category' => 'This category holds '.$products.' product(s). Removing it would leave them'
                    .' with no revenue account, so their sales would export with a blank label. Move'
                    .' them to another category first.',
            ]);
        }

        $productCategory->delete();

        return back()->with('success', 'Product category removed.');
    }

    /**
     * Resolve a submitted parent through the scoped model.
     *
     * `exists:product_categories,id` runs unscoped, so it passes for another tenant's category while
     * the scoped lookup returns null — and silently rooting the node instead would move it between
     * companies (XCT-101).
     */
    private function ownedParent(mixed $parentId): ?ProductCategory
    {
        if ($parentId === null || $parentId === '') {
            return null;
        }

        $parent = ProductCategory::query()->find((int) $parentId);

        if ($parent === null) {
            throw ValidationException::withMessages([
                'parent_id' => 'That parent category no longer exists.',
            ]);
        }

        return $parent;
    }

    /**
     * One rule set for both doors, so they cannot drift the way the POS category ones did (BAN-422).
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:96'],
            'parent_id' => ['sometimes', 'nullable', 'integer'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            // The revenue account. Free-form because it has to fit whatever chart of accounts the
            // site keeps, and nullable because an uncategorised product must still export rather
            // than block the period — but unique per company, since two categories claiming one
            // account make the export impossible to read back.
            'ledger_code' => ['sometimes', 'nullable', 'string', 'max:32'],
        ]);

        $this->assertLedgerCodeIsFree($data['ledger_code'] ?? null, $request->route('productCategory'));

        return $data;
    }

    /**
     * One revenue account, one category.
     *
     * Checked through the scoped model rather than with `Rule::unique()->where('company_id', ...)`.
     * That rule form cannot express ownership here: `ActingCompany::id()` answers `UNRESTRICTED` for
     * a super-admin and `null` for a user belonging nowhere, so the clause becomes `company_id = null`
     * — matching nothing, and quietly turning the check off for the one account most likely to be
     * doing bulk setup.
     *
     * Two categories claiming the same account make the export impossible to read back: the label
     * column stops identifying which category a sales row came from, which is the entire job of the
     * column (BAN-448).
     */
    private function assertLedgerCodeIsFree(?string $code, ?ProductCategory $editing): void
    {
        if ($code === null || trim($code) === '') {
            return;
        }

        $clash = ProductCategory::query()
            ->where('ledger_code', $code)
            ->when($editing !== null, fn ($q) => $q->whereKeyNot($editing?->getKey()))
            ->value('name');

        if ($clash !== null) {
            throw ValidationException::withMessages([
                'ledger_code' => 'The account '.$code.' is already used by "'.$clash.'". Two categories'
                    .' on one account make the accounting export impossible to read back.',
            ]);
        }
    }
}
