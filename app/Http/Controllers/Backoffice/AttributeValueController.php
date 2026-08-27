<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductAttributeValue;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;

/**
 * The values of an attribute — "small", "medium", "large" (BOF-085, BAN-412).
 *
 * Nested under their attribute because a value has no meaning without one: "large" is not a thing a
 * venue owns, "Size: large" is.
 *
 * A value carries no price. What a value *costs* is per product and lives on the attribute line
 * (`product_attribute_line_values.price_extra`), because "large" is +2.00 on a coffee and +6.00 on a
 * pizza, and a venue that had to choose one number would stop using the feature.
 */
final class AttributeValueController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function store(Request $request, ProductAttribute $attribute): RedirectResponse
    {
        Gate::authorize('update', $attribute);

        $data = $this->validated($request, $attribute, null);

        ProductAttributeValue::query()->create([
            ...$data,
            'product_attribute_id' => $attribute->getKey(),
        ]);

        return back()->with('success', 'Value added.');
    }

    public function update(Request $request, ProductAttribute $attribute, ProductAttributeValue $value): RedirectResponse
    {
        Gate::authorize('update', $attribute);

        $this->assertBelongsTo($attribute, $value);

        $value->forceFill($this->validated($request, $attribute, $value))->save();

        return back()->with('success', 'Value saved.');
    }

    /**
     * `DELETE /product-attributes/{attribute}/values/{value}` — remove a value (BOF-085).
     *
     * Refused once any product offers it. `product_attribute_line_values.product_attribute_value_id`
     * is `restrictOnDelete`, so the database refuses too — but only after the request has become a
     * 500, and it says nothing about which product is in the way.
     *
     * That restriction is also what protects history: `pos_order_lines` records the chosen values,
     * so an order that said "no onions" must keep saying it. **Deactivate** is the answer almost
     * every time — the value leaves the till and every past order keeps what it was sold with.
     */
    public function destroy(Request $request, ProductAttribute $attribute, ProductAttributeValue $value): RedirectResponse
    {
        Gate::authorize('update', $attribute);

        $this->assertBelongsTo($attribute, $value);

        $offered = $this->connection->table('product_attribute_line_values')
            ->where('product_attribute_value_id', $value->getKey())
            ->count();

        if ($offered > 0) {
            throw ValidationException::withMessages([
                'value' => 'This option is offered by '.$offered.' product(s), and past orders record'
                    .' what was chosen. Take it off them first, or deactivate it — a deactivated value'
                    .' disappears from the till and the history stays readable.',
            ]);
        }

        $value->delete();

        return back()->with('success', 'Value removed.');
    }

    /** The value must belong to the attribute in the URL. */
    private function assertBelongsTo(ProductAttribute $attribute, ProductAttributeValue $value): void
    {
        if ((int) $value->product_attribute_id !== (int) $attribute->getKey()) {
            throw ValidationException::withMessages([
                'value' => 'That value belongs to a different attribute.',
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, ProductAttribute $attribute, ?ProductAttributeValue $value): array
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:96'],
            // Only meaningful when the attribute renders as colour swatches; harmless otherwise.
            'html_color' => ['sometimes', 'nullable', 'string', 'max:9'],
            // A value the guest types rather than picks — "name on the cake". The register prompts
            // for text instead of offering a button.
            'is_custom' => ['sometimes', 'boolean'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $name = trim((string) $data['name']);

        $clash = ProductAttributeValue::query()
            ->where('product_attribute_id', $attribute->getKey())
            ->whereRaw('LOWER(name) = ?', [mb_strtolower($name)])
            ->when($value !== null, fn ($q) => $q->whereKeyNot($value?->getKey()))
            ->exists();

        if ($clash) {
            throw ValidationException::withMessages([
                'name' => '"'.$name.'" is already a value of this attribute. Two identical options on'
                    .' one picker are indistinguishable at the till.',
            ]);
        }

        return $data;
    }
}
