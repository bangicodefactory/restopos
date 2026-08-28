<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\PricelistAppliedOn;
use App\Enums\PricelistBase;
use App\Enums\PricelistComputePrice;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductVariant;
use App\Models\Pricing\Pricelist;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * One price rule (BOF-037, BAN-401).
 *
 * A rule branches two ways and the branches are independent, which is what makes this more than a
 * form:
 *
 *  - **`applied_on`** decides *what* it covers — one variant, one product, a POS category, or
 *    everything — and exactly one of the three id columns may be set accordingly.
 *  - **`compute_price`** decides *how* the price is worked out — a flat price, a percentage off, or
 *    a formula over some base with a discount, a surcharge, rounding and margin bounds.
 *
 * Both are validated here rather than left to the database, because every one of these columns is
 * `NOT NULL` with a default. Sending `applied_on: product` with no `product_id` does not fail — it
 * stores a rule that matches *nothing*, and the operator finds out when a price does not change.
 *
 * ## Why the ids are checked through the scoped model
 *
 * `products`, `product_variants` and `pos_categories` all carry a `company_id`, and `Rule::exists`
 * runs on the query builder — the one place `CompanyScope` cannot reach (`ScopedExistsTest`). A rule
 * naming another venue's product would price *their* item on *our* till.
 */
final class PricelistItemRequest extends FormRequest
{
    public function authorize(): bool
    {
        $pricelist = $this->route('pricelist');

        return $pricelist instanceof Pricelist && $this->user()?->can('update', $pricelist) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $creating = $this->route('item') === null;
        $required = $creating ? 'required' : 'sometimes';

        return [
            'applied_on' => [$required, Rule::enum(PricelistAppliedOn::class)],
            'product_variant_id' => ['sometimes', 'nullable', 'integer', $this->owned(ProductVariant::class)],
            'product_id' => ['sometimes', 'nullable', 'integer', $this->owned(Product::class)],
            'pos_category_id' => ['sometimes', 'nullable', 'integer', $this->owned(PosCategory::class)],

            'min_quantity' => ['sometimes', 'numeric', 'min:0'],
            'date_start' => ['sometimes', 'nullable', 'date'],
            'date_end' => ['sometimes', 'nullable', 'date'],

            'compute_price' => [$required, Rule::enum(PricelistComputePrice::class)],
            'fixed_price' => ['sometimes', 'numeric', 'min:0'],
            'percent_price' => ['sometimes', 'numeric', 'min:0', 'max:100'],
            'base' => ['sometimes', Rule::enum(PricelistBase::class)],
            'base_pricelist_id' => ['sometimes', 'nullable', 'integer', $this->owned(Pricelist::class)],
            'price_discount' => ['sometimes', 'numeric'],
            'price_surcharge' => ['sometimes', 'numeric'],
            'price_round' => ['sometimes', 'numeric', 'min:0'],
            'price_min_margin' => ['sometimes', 'numeric'],
            'price_max_margin' => ['sometimes', 'numeric'],

            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertTargetMatchesScope($validator);
            $this->assertComputeInputsPresent($validator);
            $this->assertWindowIsOrdered($validator);
            $this->assertBaseIsNotItself($validator);
        });
    }

    /**
     * `applied_on` names one thing; exactly that thing must be identified.
     *
     * Every id column is nullable and every one of them defaults to null, so a rule saying "this
     * applies to a product" with no product named is accepted by the database and then matches
     * nothing. The operator sees a saved rule and an unchanged price.
     */
    private function assertTargetMatchesScope(Validator $validator): void
    {
        $scope = $this->input('applied_on');

        $field = match ($scope) {
            PricelistAppliedOn::Variant->value => 'product_variant_id',
            PricelistAppliedOn::Product->value => 'product_id',
            PricelistAppliedOn::PosCategory->value => 'pos_category_id',
            default => null,
        };

        if ($field === null) {
            return;
        }

        if ($this->input($field) === null) {
            $validator->errors()->add($field, 'This rule says it applies to one of these, so name which one — otherwise it matches nothing and no price changes.');
        }
    }

    /**
     * The numbers the chosen calculation actually reads.
     *
     * A percentage rule with no percentage is a 0 % discount, which is a rule that saves cleanly and
     * does nothing. Same for a fixed rule with no price: it would sell the item for zero.
     */
    private function assertComputeInputsPresent(Validator $validator): void
    {
        $compute = $this->input('compute_price');

        if ($compute === PricelistComputePrice::Fixed->value && (float) $this->input('fixed_price', 0) <= 0) {
            $validator->errors()->add('fixed_price', 'A fixed price of zero would sell this for nothing. Enter the price this rule should charge.');
        }

        if ($compute === PricelistComputePrice::Percentage->value && (float) $this->input('percent_price', 0) <= 0) {
            $validator->errors()->add('percent_price', 'A discount of zero per cent changes no price. Enter the discount this rule should apply.');
        }

        if ($compute === PricelistComputePrice::Formula->value
            && $this->input('base') === PricelistBase::Pricelist->value
            && $this->input('base_pricelist_id') === null) {
            $validator->errors()->add('base_pricelist_id', 'This rule computes from another price list, so name which one.');
        }
    }

    /** A window that closes before it opens never applies, and nothing would say so. */
    private function assertWindowIsOrdered(Validator $validator): void
    {
        $start = $this->input('date_start');
        $end = $this->input('date_end');

        if ($start !== null && $end !== null && strtotime((string) $end) < strtotime((string) $start)) {
            $validator->errors()->add('date_end', 'This rule would stop before it started, so it would never apply.');
        }
    }

    /**
     * A price list computed from itself.
     *
     * `PricingService::ancestryFor` walks the base chain with a `$guard++ < 10` stop, so a
     * self-reference does not hang — it silently gives up after ten hops and prices from the wrong
     * thing. Refusing the obvious case here is cheap; the deeper cycle is caught by that guard.
     */
    private function assertBaseIsNotItself(Validator $validator): void
    {
        $pricelist = $this->route('pricelist');
        $base = $this->input('base_pricelist_id');

        if ($pricelist instanceof Pricelist && $base !== null && (int) $base === (int) $pricelist->getKey()) {
            $validator->errors()->add('base_pricelist_id', 'A price list cannot be computed from itself.');
        }
    }

    /**
     * An id that resolves through the scoped model.
     *
     * @param  class-string<Model>  $model
     */
    private function owned(string $model): callable
    {
        return static function (string $attribute, mixed $value, callable $fail) use ($model): void {
            if ($value === null) {
                return;
            }

            if (! $model::query()->whereKey((int) $value)->exists()) {
                $fail('That belongs to another venue, or no longer exists.');
            }
        };
    }
}
