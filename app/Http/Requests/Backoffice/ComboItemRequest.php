<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Models\Catalog\Combo;
use App\Models\Catalog\ComboItem;
use App\Models\Catalog\ProductVariant;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * One dish a course offers (BOF-088, BAN-416).
 *
 * `extra_price` is the supplement: the fillet costs three euros more than the chicken, and the rest
 * of the menu price is unchanged. It is added to the customer's total on top of the menu price and
 * is *not* part of the distribution — `ComboPriceDistributor` splits the menu's own price by the
 * courses' `base_price` weights, and the supplement rides on its own line.
 *
 * ## The variant is checked through the scoped model
 *
 * `product_variants` carries a `company_id`, and `Rule::exists` runs on the query builder, the one
 * place `CompanyScope` cannot reach (`ScopedExistsTest`). A course offering another venue's dish
 * would put their item on our kitchen ticket and price it from their catalogue.
 */
final class ComboItemRequest extends FormRequest
{
    public function authorize(): bool
    {
        $combo = $this->route('combo');

        return $combo instanceof Combo && $this->user()?->can('update', $combo) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $required = $this->route('item') === null ? 'required' : 'sometimes';

        return [
            'product_variant_id' => [$required, 'integer', $this->ownedVariant()],
            // A negative supplement is a discount for choosing one dish over another, which is a
            // real thing a menu does — the fish option two euros cheaper. `min:0` would refuse it.
            'extra_price' => ['sometimes', 'numeric'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertDishIsNotAlreadyOffered($validator);
        });
    }

    /**
     * The same dish twice in one course.
     *
     * `combo_items` has a unique index on `(combo_id, product_variant_id)`, so this arrives from the
     * database as a 500 rather than as a field error. It is a real mistake to make — the picker
     * lists every variant in the catalogue, including the ones already on the course.
     */
    private function assertDishIsNotAlreadyOffered(Validator $validator): void
    {
        $combo = $this->route('combo');
        $variantId = $this->input('product_variant_id');

        if (! $combo instanceof Combo || $variantId === null) {
            return;
        }

        $item = $this->route('item');

        $taken = $combo->items()
            ->where('product_variant_id', (int) $variantId)
            ->when($item instanceof ComboItem, fn ($query) => $query->whereKeyNot($item->getKey()))
            ->exists();

        if ($taken) {
            $validator->errors()->add('product_variant_id', 'This course already offers that dish.');
        }
    }

    private function ownedVariant(): callable
    {
        return static function (string $attribute, mixed $value, callable $fail): void {
            if ($value === null) {
                return;
            }

            if (! ProductVariant::query()->whereKey((int) $value)->exists()) {
                $fail('That dish belongs to another venue, or no longer exists.');
            }
        };
    }
}
