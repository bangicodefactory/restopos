<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Models\Catalog\Combo;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * One choice group of a set menu (BOF-088, BAN-416).
 *
 * A `combos` row is not a menu — it is **one course of one**: "Starters", "Mains", "Dessert or
 * coffee". The menu itself is a product, and the groups hang off it through `combo_product`. That is
 * why this has a `base_price` of its own: the group's price is the weight the distributor uses to
 * decide how much of the menu's price each course carries.
 *
 * ## `qty_free` and `qty_max`
 *
 * How many choices the group gives away and how many it will accept. Both are `unsignedSmallInteger`
 * with a default of 1, so every wrong value is a value the database takes:
 *
 *  - `qty_max` of 0 accepts no choice at all, and the course silently disappears from the menu
 *  - `qty_free` above `qty_max` gives away more choices than can be made, so the surplus is free of
 *    a thing that cannot be ordered — which reads on screen as a generous menu and is arithmetic
 *    that never runs
 *
 * ## Why `base_price` matters more than it looks
 *
 * `ComboPriceDistributor` weights each component by **its group's `base_price`**, not by the dish's
 * own price. So these numbers do not decide what the customer pays — the menu's price does that —
 * they decide how the menu's price is split across the courses on the receipt and on the kitchen
 * ticket. A group priced at zero takes none of it, and the last component absorbs the residue.
 */
final class ComboRequest extends FormRequest
{
    public function authorize(): bool
    {
        $combo = $this->route('combo');

        return $combo instanceof Combo
            ? $this->user()?->can('update', $combo) === true
            : $this->user()?->can('create', Combo::class) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $required = $this->route('combo') === null ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:96'],
            'base_price' => ['sometimes', 'numeric', 'min:0'],
            'qty_free' => ['sometimes', 'integer', 'min:0', 'max:65535'],
            'qty_max' => ['sometimes', 'integer', 'min:1', 'max:65535'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertAllowanceFitsTheLimit($validator);
        });
    }

    /** A group cannot give away more choices than it will accept. */
    private function assertAllowanceFitsTheLimit(Validator $validator): void
    {
        $combo = $this->route('combo');

        $free = $this->has('qty_free')
            ? (int) $this->input('qty_free')
            : ($combo instanceof Combo ? (int) $combo->qty_free : 1);

        $max = $this->has('qty_max')
            ? (int) $this->input('qty_max')
            : ($combo instanceof Combo ? (int) $combo->qty_max : 1);

        if ($free > $max) {
            $validator->errors()->add('qty_free', 'This course would include more choices than it lets the customer make. Raise the maximum, or lower how many are included.');
        }
    }
}
