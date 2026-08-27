<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductAttributeLine;
use App\Models\Catalog\ProductAttributeValue;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * Which options a *product* offers, and what each one adds to its price (BOF-085, BAN-412).
 *
 * An attribute line is the join between a venue-wide attribute ("Size") and one dish: which of its
 * values this dish offers, in what order, and the supplement each carries. The supplement lives here
 * rather than on the value because "large" is +2.00 on a coffee and +6.00 on a pizza.
 *
 * `LinePriceAuthority` reads these supplements to verify what a till charged, so this is a
 * money-carrying surface: a wrong number here is not a display bug, it is the price.
 */
final class ProductAttributeLineController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    /**
     * Attach an attribute to a product, with the values it offers.
     *
     * Values and their supplements arrive together because a line with no values is a picker with no
     * options — rendered on the till, tappable, and empty.
     */
    public function store(Request $request, Product $product): RedirectResponse
    {
        Gate::authorize('update', $product);

        $data = $this->validated($request);
        $attribute = $this->ownedAttribute((int) $data['product_attribute_id']);

        if (ProductAttributeLine::query()
            ->where('product_id', $product->getKey())
            ->where('product_attribute_id', $attribute->getKey())
            ->exists()) {
            throw ValidationException::withMessages([
                'product_attribute_id' => 'This product already offers "'.$attribute->name.'".'
                    .' Edit that line instead of adding a second one.',
            ]);
        }

        $values = $this->ownedValues($attribute, $data['values'] ?? []);

        $this->connection->transaction(function () use ($product, $attribute, $data, $values): void {
            /** @var ProductAttributeLine $line */
            $line = ProductAttributeLine::query()->create([
                'product_id' => $product->getKey(),
                'product_attribute_id' => $attribute->getKey(),
                'is_required' => (bool) ($data['is_required'] ?? true),
                'sequence' => $data['sequence'] ?? 10,
                'active' => true,
            ]);

            $this->syncValues($product, $line, $values);
        });

        return back()->with('success', 'Options added.');
    }

    public function update(Request $request, Product $product, ProductAttributeLine $line): RedirectResponse
    {
        Gate::authorize('update', $product);

        $this->assertBelongsTo($product, $line);

        $data = $this->validated($request, requireAttribute: false);
        $attribute = $line->attribute;

        if ($attribute === null) {
            throw ValidationException::withMessages(['product_attribute_id' => 'No such attribute.']);
        }

        $values = array_key_exists('values', $data)
            ? $this->ownedValues($attribute, $data['values'])
            : null;

        $this->connection->transaction(function () use ($product, $line, $data, $values): void {
            $line->forceFill([
                'is_required' => (bool) ($data['is_required'] ?? $line->is_required),
                'sequence' => $data['sequence'] ?? $line->sequence,
                'active' => (bool) ($data['active'] ?? $line->active),
            ])->save();

            if ($values !== null) {
                $this->syncValues($product, $line, $values);
            }
        });

        return back()->with('success', 'Options saved.');
    }

    /**
     * `DELETE /products/{product}/attribute-lines/{line}` — stop offering an attribute.
     *
     * Refused once an order has recorded a choice from it. `pos_order_lines` references the chosen
     * `product_attribute_line_values` under `restrictOnDelete`, so removing the line would either be
     * a database refusal or — if it cascaded — a sold "no onions" that can no longer say what it
     * meant.
     */
    public function destroy(Request $request, Product $product, ProductAttributeLine $line): RedirectResponse
    {
        Gate::authorize('update', $product);

        $this->assertBelongsTo($product, $line);

        $lineValueIds = $this->connection->table('product_attribute_line_values')
            ->where('product_attribute_line_id', $line->getKey())
            ->pluck('id')
            ->all();

        $sold = $this->timesChosen($lineValueIds);

        if ($sold > 0) {
            throw ValidationException::withMessages([
                'line' => 'Orders have recorded '.$sold.' choice(s) from these options, and those'
                    .' orders must keep saying what was chosen. Deactivate the line instead — it'
                    .' disappears from the till and the history stays readable.',
            ]);
        }

        $this->connection->transaction(function () use ($line): void {
            $this->connection->table('product_attribute_line_values')
                ->where('product_attribute_line_id', $line->getKey())
                ->delete();

            $line->delete();
        });

        return back()->with('success', 'Options removed.');
    }

    /**
     * Reconcile the offered values, preserving ids so a supplement edit does not orphan an order.
     *
     * `pos_order_lines` points at a `product_attribute_line_values` row, so recreating them on every
     * save would break every order that referenced the old ids. Kept rows are updated in place;
     * only genuinely dropped ones are deleted, and a dropped one that has been sold is refused.
     *
     * @param  list<array{product_attribute_value_id: int, price_extra: string}>  $values
     */
    private function syncValues(Product $product, ProductAttributeLine $line, array $values): void
    {
        $existing = $this->connection->table('product_attribute_line_values')
            ->where('product_attribute_line_id', $line->getKey())
            ->pluck('id', 'product_attribute_value_id');

        $keptIds = [];

        foreach (array_values($values) as $index => $value) {
            $valueId = (int) $value['product_attribute_value_id'];
            $payload = [
                'price_extra' => (string) ($value['price_extra'] ?? '0'),
                'sequence' => ($index + 1) * 10,
                'active' => true,
                'updated_at' => now(),
            ];

            if (isset($existing[$valueId])) {
                $this->connection->table('product_attribute_line_values')
                    ->where('id', $existing[$valueId])
                    ->update($payload);

                $keptIds[] = (int) $existing[$valueId];

                continue;
            }

            $keptIds[] = (int) $this->connection->table('product_attribute_line_values')->insertGetId([
                ...$payload,
                'product_attribute_line_id' => $line->getKey(),
                'product_attribute_value_id' => $valueId,
                'product_id' => $product->getKey(),
                'created_at' => now(),
            ]);
        }

        $dropped = $existing->values()->map(static fn (mixed $v): int => (int) $v)
            ->reject(static fn (int $id): bool => in_array($id, $keptIds, true))
            ->all();

        if ($dropped === []) {
            return;
        }

        $sold = $this->timesChosen($dropped);

        if ($sold > 0) {
            throw ValidationException::withMessages([
                'values' => 'An option you removed has been chosen on '.$sold.' order line(s), and'
                    .' those orders must keep saying what was chosen. Leave it on the product and'
                    .' deactivate it instead.',
            ]);
        }

        $this->connection->table('product_attribute_line_values')->whereIn('id', $dropped)->delete();
    }

    /**
     * How many order lines recorded a choice from these values.
     *
     * Two tables reference them and both are `restrictOnDelete`: the picked-value pivot, and the
     * *custom* values a guest typed ("name on the cake"). Counting only the first would let a delete
     * through that the database then refuses as a 500 — and the custom one is the likelier of the two
     * to be forgotten, because it is the branch nobody thinks about.
     *
     * @param  list<int>  $lineValueIds
     */
    private function timesChosen(array $lineValueIds): int
    {
        if ($lineValueIds === []) {
            return 0;
        }

        return $this->connection->table('pos_order_line_attribute_value')
            ->whereIn('product_attribute_line_value_id', $lineValueIds)
            ->count()
            + $this->connection->table('pos_order_line_custom_attribute_values')
                ->whereIn('product_attribute_line_value_id', $lineValueIds)
                ->count();
    }

    /** The line must be one of this product's. */
    private function assertBelongsTo(Product $product, ProductAttributeLine $line): void
    {
        if ((int) $line->product_id !== (int) $product->getKey()) {
            throw ValidationException::withMessages([
                'line' => 'Those options belong to a different product.',
            ]);
        }
    }

    /** Resolved through the scoped model: an attribute of another venue is not ours to offer. */
    private function ownedAttribute(int $id): ProductAttribute
    {
        $attribute = ProductAttribute::query()->find($id);

        if ($attribute === null) {
            throw ValidationException::withMessages([
                'product_attribute_id' => 'No such attribute.',
            ]);
        }

        return $attribute;
    }

    /**
     * Every submitted value must belong to the attribute being attached.
     *
     * Not merely "must exist": offering "Large" from Size while attaching Spice level renders a
     * picker whose options come from two different questions, and the exclusion rules that guard
     * incompatible pairs are defined per line.
     *
     * @param  list<mixed>  $values
     * @return list<array{product_attribute_value_id: int, price_extra: string}>
     */
    private function ownedValues(ProductAttribute $attribute, array $values): array
    {
        $wanted = [];

        foreach ($values as $value) {
            $id = (int) ($value['product_attribute_value_id'] ?? 0);
            $wanted[$id] = ['product_attribute_value_id' => $id, 'price_extra' => (string) ($value['price_extra'] ?? '0')];
        }

        if ($wanted === []) {
            return [];
        }

        $found = ProductAttributeValue::query()
            ->where('product_attribute_id', $attribute->getKey())
            ->whereKey(array_keys($wanted))
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        $missing = array_values(array_diff(array_keys($wanted), $found));

        if ($missing !== []) {
            throw ValidationException::withMessages([
                'values' => 'Those options do not belong to "'.$attribute->name.'": '
                    .implode(', ', $missing).'.',
            ]);
        }

        return array_values($wanted);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $requireAttribute = true): array
    {
        return $request->validate([
            'product_attribute_id' => [$requireAttribute ? 'required' : 'sometimes', 'integer'],
            // Whether the cashier must choose before the line can be added. A required picker with
            // no default is what stops "one coffee" reaching the kitchen without a size.
            'is_required' => ['sometimes', 'boolean'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],

            'values' => ['sometimes', 'array'],
            'values.*.product_attribute_value_id' => ['required', 'integer'],
            // What this option adds to *this* product's price. Verified server-side by
            // `LinePriceAuthority`, so it is the price rather than a label.
            'values.*.price_extra' => ['sometimes', 'numeric'],
        ]);
    }
}
