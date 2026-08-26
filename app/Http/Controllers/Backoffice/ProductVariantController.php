<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\SessionState;
use App\Http\Controllers\Backoffice\Concerns\DetectsRealChanges;
use App\Http\Controllers\Controller;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Variants of a product — the sizes, the flavours, the thing an order line actually points at
 * (BOF-087, BAN-409).
 *
 * `pos_order_lines.product_variant_id` is what a sale references, so a variant is not a decoration
 * on a product: it *is* the sellable unit. Until now they were listed read-only and every variant in
 * the system came from a seeder, which meant a venue could not add a large size, give one its own
 * barcode, or set a price supplement.
 *
 * Nested under the product because a variant has no meaning without one, and because the product is
 * what the operator is looking at when they need this.
 */
final class ProductVariantController extends Controller
{
    use DetectsRealChanges;

    public function __construct(private readonly ConnectionInterface $connection) {}

    public function store(Request $request, Product $product): RedirectResponse
    {
        Gate::authorize('update', $product);

        $data = $this->validated($request, $product, null, creating: true);

        ProductVariant::query()->create([
            ...$data,
            'product_id' => $product->getKey(),
            'company_id' => $product->company_id,
            'uuid' => (string) Str::uuid(),
            'display_name' => ProductVariant::displayNameFor($product, $data['name_suffix'] ?? null),
        ]);

        return back()->with('success', 'Variant added.');
    }

    public function update(Request $request, Product $product, ProductVariant $variant): RedirectResponse
    {
        Gate::authorize('update', $product);

        $this->assertBelongsTo($product, $variant);

        $data = $this->validated($request, $product, $variant, creating: false);

        // BOF-083, same rule as the product itself: the register holds a bootstrapped catalogue, so
        // a variant withdrawn mid-service is still on the till in front of the cashier. Prices and
        // names may move — a sold line records what it charged — but existence may not.
        if ($this->realChanges($variant, $data, ['active']) !== [] && $this->hasOpenSession()) {
            throw ValidationException::withMessages([
                'active' => 'A session is open. Whether this variant is available can be changed once'
                    .' it closes — the till is already holding a copy of the menu.',
            ]);
        }

        if (array_key_exists('name_suffix', $data)) {
            $data['display_name'] = ProductVariant::displayNameFor($product, $data['name_suffix']);
        }

        $variant->forceFill($data)->save();

        return back()->with('success', 'Variant saved.');
    }

    /**
     * `DELETE /products/{product}/variants/{variant}` — archive a variant (BOF-087).
     *
     * Archive rather than erase: `pos_order_lines.product_variant_id` is what every sale points at,
     * so a real delete of anything ever sold is a database refusal — and a history that cannot say
     * *which* size was sold is worse than a catalogue carrying a discontinued one.
     *
     * The last variant cannot go. A product with none is listable, editable and unsellable, because
     * an order line has nothing to reference — an item that appears on the menu and cannot be added,
     * with nothing on screen explaining why.
     */
    public function destroy(Request $request, Product $product, ProductVariant $variant): RedirectResponse
    {
        Gate::authorize('update', $product);

        $this->assertBelongsTo($product, $variant);

        if ($this->hasOpenSession()) {
            throw ValidationException::withMessages([
                'variant' => 'A session is open. Close it before archiving this variant — the till is'
                    .' holding a copy of the menu that still contains it.',
            ]);
        }

        $remaining = ProductVariant::query()
            ->where('product_id', $product->getKey())
            ->whereKeyNot($variant->getKey())
            ->where('active', true)
            ->count();

        if ($remaining === 0) {
            throw ValidationException::withMessages([
                'variant' => 'This is the only variant left. A product with none cannot be added to an'
                    .' order at all — archive the product instead.',
            ]);
        }

        $this->connection->transaction(function () use ($variant): void {
            $variant->forceFill(['active' => false])->save();
            $variant->delete();
        });

        return back()->with('success', 'Variant archived.');
    }

    /**
     * The variant must be one of this product's.
     *
     * Both are resolved through the scoped model, so neither can belong to another tenant — but
     * nothing stops a request naming product A and a variant of product B, and the update would then
     * write to a variant the operator is not looking at.
     */
    private function assertBelongsTo(Product $product, ProductVariant $variant): void
    {
        if ((int) $variant->product_id !== (int) $product->getKey()) {
            throw ValidationException::withMessages([
                'variant' => 'That variant belongs to a different product.',
            ]);
        }
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
     * @return array<string, mixed>
     */
    private function validated(
        Request $request,
        Product $product,
        ?ProductVariant $variant,
        bool $creating,
    ): array {
        $data = $request->validate([
            // What distinguishes this variant: "Large", "Sans gluten". Blank for the single variant
            // an attribute-less product carries.
            'name_suffix' => ['sometimes', 'nullable', 'string', 'max:160'],
            'default_code' => ['sometimes', 'nullable', 'string', 'max:64'],
            'barcode' => ['sometimes', 'nullable', 'string', 'max:64'],

            // Added to the product's price. Kept as a supplement rather than an absolute so a
            // repricing of the product carries to every size, which is what a venue means by
            // "large is two euros more".
            'price_extra' => ['sometimes', 'numeric'],
            // An absolute override, when a size genuinely is not "base plus something".
            'list_price' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'standard_price' => ['sometimes', 'numeric', 'min:0'],

            'on_hand_qty' => ['sometimes', 'numeric'],
            'self_order_available' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $this->assertBarcodeIsFree($product, $variant, $data['barcode'] ?? null);

        return $data;
    }

    /**
     * One barcode, one thing to scan.
     *
     * `product_variants` carries a `unique(company_id, barcode)` index, so without this a duplicate
     * is an SQLSTATE 23000 reaching an operator as a 500 that names nothing.
     *
     * **Products are checked too, and the database does not do that.** `products` has its own
     * separate `unique(company_id, barcode)`, so a variant may legally take a barcode a *product*
     * already uses — and the register's scan index resolves a product barcode only when no variant
     * has claimed it (`catalog-load.ts`). The collision therefore silently redirects the scan to the
     * wrong item: the same barcode rings up a different thing than it did yesterday, and nothing
     * anywhere reports a conflict.
     */
    private function assertBarcodeIsFree(Product $product, ?ProductVariant $variant, ?string $barcode): void
    {
        $barcode = trim((string) $barcode);

        if ($barcode === '') {
            return;
        }

        $clash = ProductVariant::query()
            ->where('barcode', $barcode)
            ->when($variant !== null, fn ($q) => $q->whereKeyNot($variant?->getKey()))
            ->value('display_name');

        if ($clash !== null) {
            throw ValidationException::withMessages([
                'barcode' => 'The barcode '.$barcode.' already belongs to "'.$clash.'".',
            ]);
        }

        $productClash = Product::query()
            ->where('barcode', $barcode)
            ->whereKeyNot($product->getKey())
            ->value('name');

        if ($productClash !== null) {
            throw ValidationException::withMessages([
                'barcode' => 'The barcode '.$barcode.' is already the product barcode of "'
                    .$productClash.'". Scanning it would ring up whichever of the two the till'
                    .' indexed first.',
            ]);
        }
    }
}
