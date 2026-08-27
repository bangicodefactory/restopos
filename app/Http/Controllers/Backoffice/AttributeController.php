<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\AttributeCreateVariant;
use App\Enums\AttributeDisplayType;
use App\Http\Controllers\Controller;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductAttributeValue;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Product attributes and their values — "Size: small / medium / large" (BOF-085, BAN-412).
 *
 * The consuming half of this feature has always worked. The register bootstraps attributes, values,
 * attribute lines and their exclusions; `VariantDialog` renders the option picker from them and
 * disables incompatible pairs; `LinePriceAuthority` verifies the per-value supplement server-side so
 * a till cannot invent one. What did not exist was any way to *author* them: no route, no
 * controller, no page, so every option in every venue came from the seeder.
 *
 * Attributes are defined once for the venue and *attached* to products, because "Size" means the
 * same thing on every dish and a per-product copy is three spellings of "Large" by the second month.
 * The per-product part — which values this dish offers and what each adds to its price — lives on
 * the product, in `ProductAttributeLineController`.
 */
final class AttributeController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', ProductAttribute::class);

        return Inertia::render('Attributes/Index', [
            'attributes' => ProductAttribute::query()
                ->with(['values' => fn ($q) => $q->orderBy('sequence')->orderBy('id')])
                ->withCount('lines')
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(static fn (ProductAttribute $a): array => [
                    'id' => (int) $a->getKey(),
                    'name' => (string) $a->name,
                    'display_type' => (string) ($a->display_type?->value ?? $a->display_type),
                    'create_variant' => (string) ($a->create_variant?->value ?? $a->create_variant),
                    'sequence' => (int) $a->sequence,
                    'active' => (bool) $a->active,
                    // How many products offer this attribute — the number that decides whether a
                    // change here is a small edit or a menu-wide one.
                    'product_count' => (int) $a->lines_count,
                    'values' => $a->values->map(static fn (ProductAttributeValue $v): array => [
                        'id' => (int) $v->getKey(),
                        'name' => (string) $v->name,
                        'html_color' => $v->html_color,
                        'is_custom' => (bool) $v->is_custom,
                        'sequence' => (int) $v->sequence,
                        'active' => (bool) $v->active,
                    ])->values()->all(),
                ])->values()->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', ProductAttribute::class);

        $data = $this->validated($request, null, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding an attribute.',
            ]);
        }

        ProductAttribute::query()->create([...$data, 'company_id' => $companyId]);

        return back()->with('success', 'Attribute added.');
    }

    public function update(Request $request, ProductAttribute $attribute): RedirectResponse
    {
        Gate::authorize('update', $attribute);

        $attribute->forceFill($this->validated($request, $attribute, creating: false))->save();

        return back()->with('success', 'Attribute saved.');
    }

    /**
     * `DELETE /product-attributes/{attribute}` — remove an attribute (BOF-085).
     *
     * Refused while any product offers it. `product_attribute_lines.product_attribute_id` is
     * `restrictOnDelete`, so without this the database refuses too — as an SQLSTATE 23000 reaching a
     * manager as a 500 that names nothing.
     */
    public function destroy(Request $request, ProductAttribute $attribute): RedirectResponse
    {
        Gate::authorize('delete', $attribute);

        $lines = $this->connection->table('product_attribute_lines')
            ->where('product_attribute_id', $attribute->getKey())
            ->count();

        if ($lines > 0) {
            throw ValidationException::withMessages([
                'attribute' => 'This attribute is offered by '.$lines.' product(s). Take it off them'
                    .' first, or deactivate it — a deactivated attribute disappears from the till and'
                    .' every past order keeps the options it was sold with.',
            ]);
        }

        $attribute->delete();

        return back()->with('success', 'Attribute removed.');
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, ?ProductAttribute $attribute, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:96'],
            // What control the register and the kiosk render: radio buttons, pills, a select, colour
            // swatches, or a multi-select. Getting this wrong is not cosmetic — `multi` is the only
            // one that lets a guest pick more than one topping.
            'display_type' => ['sometimes', Rule::enum(AttributeDisplayType::class)],
            // Whether choosing a value produces a distinct variant. `always` mints one per
            // combination; `no_variant` keeps a single sellable variant and records the choice on
            // the line, which is what "no onions" wants.
            'create_variant' => ['sometimes', Rule::enum(AttributeCreateVariant::class)],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $this->assertNameIsFree($data['name'] ?? null, $attribute);

        return $data;
    }

    /**
     * One attribute per name.
     *
     * Two attributes called "Size" is not a database problem — no index forbids it — but it is an
     * operator one: the product editor offers both, half the menu ends up on each, and the register
     * renders two pickers that look identical. Compared case-insensitively for the same reason the
     * ledger codes are.
     */
    private function assertNameIsFree(?string $name, ?ProductAttribute $editing): void
    {
        $name = trim((string) $name);

        if ($name === '') {
            return;
        }

        $clash = ProductAttribute::query()
            ->whereRaw('LOWER(name) = ?', [mb_strtolower($name)])
            ->when($editing !== null, fn ($q) => $q->whereKeyNot($editing?->getKey()))
            ->exists();

        if ($clash) {
            throw ValidationException::withMessages([
                'name' => 'An attribute called "'.$name.'" already exists. Two with the same name'
                    .' render as two identical pickers on the till.',
            ]);
        }
    }
}
