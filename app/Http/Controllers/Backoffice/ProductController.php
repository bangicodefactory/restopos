<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\ProductType;
use App\Enums\SessionState;
use App\Enums\UomType;
use App\Http\Controllers\Backoffice\Concerns\DetectsRealChanges;
use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductCategory;
use App\Models\Catalog\Uom;
use App\Models\Pricing\Tax;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Products/Index` and `Products/Edit` — the menu (spec 02 BOF-080…BOF-109).
 *
 * The list is paginated server-side and consumed by Inertia's `WhenVisible`
 * infinite scroll; a catalog of 20 000 items must never be one JSON blob.
 *
 * The editor wrote eight of the `products` table's thirty-one columns (BAN-407), so weighed items,
 * stock tracking, product type, unit of measure and every description field were configurable only
 * by SQL — and nothing could create or archive a product at all, so the menu was whatever the
 * seeder produced.
 */
final class ProductController extends Controller
{
    use DetectsRealChanges;

    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(Request $request): Response
    {
        Gate::authorize('viewAny', Product::class);

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
                'uuid' => (string) $p->uuid,
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
        Gate::authorize('view', $product);

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
                'product_categories' => ProductCategory::query()->orderBy('name')->get(['id', 'name', 'ledger_code'])->all(),
                'uoms' => Uom::query()->orderBy('name')->get(['id', 'name'])->all(),
            ]),
        ]);
    }

    /**
     * `POST /products` — add a product (BOF-081).
     *
     * The menu could only be populated by a seeder, so a venue could not add the dish it started
     * serving this week.
     *
     * A product is not sellable on its own: `pos_order_lines` references a **variant**, so a product
     * with none can be created, listed, and never sold. One is minted here — the attribute-less case
     * every product starts as, which the schema documents as "exactly one".
     */
    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', Product::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a product.',
            ]);
        }

        $pivots = $this->takePivots($data);
        $data['uom_id'] ??= $this->defaultUom();

        $this->connection->transaction(function () use ($data, $companyId, $pivots): void {
            /** @var Product $product */
            $product = Product::query()->create([
                ...$data,
                'company_id' => $companyId,
                'uuid' => (string) Str::uuid(),
            ]);

            $product->variants()->create([
                'uuid' => (string) Str::uuid(),
                'company_id' => $companyId,
                'display_name' => (string) $product->name,
                'list_price' => (string) $product->list_price,
                'active' => true,
            ]);

            $this->syncPivots($product, $pivots);
        });

        return back()->with('success', 'Product added.');
    }

    public function update(Request $request, Product $product): RedirectResponse
    {
        Gate::authorize('update', $product);

        $data = $this->validated($request, creating: false);

        // BOF-083 — availability is frozen while a session is open.
        //
        // Odoo blocks archiving a POS product during an open session, and the reason is that the
        // register holds a *bootstrapped* catalogue: a product pulled mid-service is still on the
        // till in front of the cashier, still addable, and the order that includes it then names a
        // product the back office says is gone. Renaming and re-pricing are fine — a sold line
        // records what it charged — but existence is not.
        $availability = $this->realChanges($product, $data, ['available_in_pos', 'active']);

        if ($availability !== [] && $this->hasOpenSession()) {
            throw ValidationException::withMessages([
                'available_in_pos' => 'A session is open. Whether this product is available can be'
                    .' changed once it closes — the till is already holding a copy of the menu.',
            ]);
        }

        $pivots = $this->takePivots($data);

        $this->connection->transaction(function () use ($product, $data, $pivots): void {
            $product->forceFill($data)->save();
            $this->syncPivots($product, $pivots);
        });

        return back()->with('success', 'Product saved.');
    }

    /**
     * `DELETE /products/{product}` — archive a product (BOF-081, BOF-083).
     *
     * Archive, never erase, and `SoftDeletes` on the model is what makes that true: every sold line
     * holds `product_id` under `restrictOnDelete`, so a real delete of anything ever sold is a
     * database refusal — and a real delete of something never sold would still take its variants and
     * attribute lines with it.
     *
     * Refused while a session is open, for the same reason `update` freezes availability.
     */
    public function destroy(Request $request, Product $product): RedirectResponse
    {
        Gate::authorize('delete', $product);

        if ($this->hasOpenSession()) {
            throw ValidationException::withMessages([
                'product' => 'A session is open. Close it before archiving this product — the till is'
                    .' holding a copy of the menu that still contains it.',
            ]);
        }

        $this->connection->transaction(function () use ($product): void {
            // The variants go with it. Leave them active and the register bootstrap ships a sellable
            // variant whose product is archived, which reads on the till as an item that exists and
            // cannot be found.
            $product->variants()->update(['active' => false]);
            $product->forceFill(['active' => false])->save();
            $product->delete();
        });

        return back()->with('success', 'Product archived.');
    }

    /**
     * Pull the pivot lists out of the validated data, resolved and owned.
     *
     * @param  array<string, mixed>  $data
     * @return array<string, list<int>>
     */
    private function takePivots(array &$data): array
    {
        $pivots = [];

        foreach (['pos_category_ids' => PosCategory::class, 'tax_ids' => Tax::class] as $key => $model) {
            if (array_key_exists($key, $data)) {
                $pivots[$key] = $this->ownedIds($model, (array) $data[$key], $key);
                unset($data[$key]);
            }
        }

        return $pivots;
    }

    /** @param  array<string, list<int>>  $pivots */
    private function syncPivots(Product $product, array $pivots): void
    {
        foreach ($pivots as $key => $ids) {
            match ($key) {
                'pos_category_ids' => $product->posCategories()->sync($ids),
                'tax_ids' => $product->taxes()->sync($ids),
                default => null,
            };
        }
    }

    /**
     * Resolve submitted ids through the *scoped* model, refusing anything that is not ours.
     *
     * `sync()` writes whatever it is handed and both pivots took them straight from the request.
     * Probed on master: `tax_ids: [999999]` was a **500** — an FK violation surfacing as a server
     * error naming nothing — and another company's tax id **attached**. That last one is not a data
     * leak so much as a money one: this venue's sales are then computed at another venue's rate and
     * exported under their tax.
     *
     * @param  class-string<Model>  $model
     * @param  list<mixed>  $ids
     * @return list<int>
     */
    private function ownedIds(string $model, array $ids, string $field): array
    {
        $wanted = array_values(array_unique(array_map(intval(...), $ids)));

        if ($wanted === []) {
            return [];
        }

        $found = $model::query()->whereKey($wanted)->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)->all();

        $missing = array_values(array_diff($wanted, $found));

        if ($missing !== []) {
            throw ValidationException::withMessages([
                $field => 'No such record: '.implode(', ', $missing).'.',
            ]);
        }

        return $found;
    }

    /**
     * The unit a product is sold in when the form does not say.
     *
     * `products.uom_id` is NOT NULL, so a create with no unit is an integrity violation surfacing as
     * a 500 — which is what it was until this defaulted. Most products are sold in units and asking
     * every form to say so is noise; the reference unit is the one whose factor is 1, which is
     * exactly what "each" means.
     */
    private function defaultUom(): int
    {
        $id = Uom::query()->where('uom_type', UomType::Reference->value)->orderBy('id')->value('id')
            ?? Uom::query()->orderBy('id')->value('id');

        if ($id === null) {
            throw ValidationException::withMessages([
                'uom_id' => 'This venue has no units of measure configured, so a product cannot be'
                    .' created. Add one first.',
            ]);
        }

        return (int) $id;
    }

    /** Is any register of this company mid-session? */
    private function hasOpenSession(): bool
    {
        $query = $this->connection->table('pos_sessions')
            ->whereIn('state', [SessionState::Opened->value, SessionState::ClosingControl->value]);

        ActingCompany::scope($query);

        return $query->exists();
    }

    /**
     * Everything the editor may write.
     *
     * Two groups are deliberately absent, and both are absences rather than oversights:
     *
     *  - **The derived counters.** `sale_count`, `last_sold_at`, `has_image`, `attribute_count` and
     *    `combo_count` are maintained by the code that causes them. A form that can write
     *    `sale_count` is a form that can make the reports disagree with the orders.
     *  - **`special_kind` / `is_special`.** These decide **who prices the line**.
     *    `LinePriceAuthority` hands pricing to the *client* for anything whose kind is not `none`,
     *    because tips, deposits, loyalty rewards and global discounts carry amounts computed
     *    elsewhere. Marking an ordinary product `tip` therefore switches server-side price
     *    verification off for it, and a till could then send any amount and be believed. That is a
     *    deliberate, consequence-carrying act and not one field among thirty; it wants its own
     *    guarded action, which is not this ticket.
     *
     * `image_media_id` is absent for the reason payment methods gave: there is no media *upload*
     * route in the app, only `GET /api/media/{id}` to serve one, so a picker would offer a choice of
     * nothing. BAN-393 owns that pipeline.
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:200'],
            'default_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'barcode' => ['sometimes', 'nullable', 'string', 'max:64'],
            'list_price' => ['sometimes', 'numeric', 'min:0'],
            'standard_price' => ['sometimes', 'numeric', 'min:0'],

            'product_type' => ['sometimes', Rule::enum(ProductType::class)],
            'product_category_id' => ['sometimes', 'nullable', 'integer'],
            // `products.uom_id` is NOT NULL, so this is not optional the way the nullable columns
            // beside it are — it is defaulted rather than demanded. See `defaultUom()`.
            'uom_id' => ['sometimes', 'integer'],

            'available_in_pos' => ['sometimes', 'boolean'],
            'self_order_available' => ['sometimes', 'boolean'],
            'sale_ok' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],

            // Sold by weight: the register reads a quantity from the scale instead of counting units.
            'to_weight' => ['sometimes', 'boolean'],
            'track_stock' => ['sometimes', 'boolean'],
            'allow_negative_stock' => ['sometimes', 'boolean'],

            'description_sale' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'public_description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'internal_note' => ['sometimes', 'nullable', 'string', 'max:2000'],

            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'pos_sequence' => ['sometimes', 'integer'],
            'is_favorite' => ['sometimes', 'boolean'],

            'pos_category_ids' => ['sometimes', 'array'],
            'pos_category_ids.*' => ['integer'],
            'tax_ids' => ['sometimes', 'array'],
            'tax_ids.*' => ['integer'],
        ]);

        // Resolved through the scoped models rather than with `exists` rules, which run unscoped and
        // would pass for another tenant's row.
        foreach (['product_category_id' => ProductCategory::class, 'uom_id' => Uom::class] as $key => $model) {
            if (! empty($data[$key]) && ! $model::query()->whereKey((int) $data[$key])->exists()) {
                throw ValidationException::withMessages([$key => 'No such record.']);
            }
        }

        return $data;
    }
}
