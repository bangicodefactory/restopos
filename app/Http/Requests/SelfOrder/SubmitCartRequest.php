<?php

declare(strict_types=1);

namespace App\Http\Requests\SelfOrder;

use Illuminate\Foundation\Http\FormRequest;

/**
 * `POST /api/self-order/{configToken}/orders` (SLF-020…059).
 *
 * Note what is **absent**: prices. The cart may not propose them. The server
 * resolves every line price from the catalog and the applicable pricelist; a
 * payload that carries `price_unit` anyway is recorded as a `price_tamper`
 * conflict and ignored (spec 01-schema §5.6).
 */
final class SubmitCartRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'order_uuid' => ['nullable', 'string', 'size:36'],
            // Only meaningful alongside an `order_uuid` that already exists: it is how the caller
            // proves the order is theirs (BAN-496). Usually sent as the `X-Order-Token` header.
            'order_token' => ['nullable', 'string', 'max:64'],
            'preset_id' => ['nullable', 'integer'],
            'customer_note' => ['nullable', 'string', 'max:2000'],
            'customer_email' => ['nullable', 'email', 'max:160'],
            'customer_phone' => ['nullable', 'string', 'max:40'],
            'table_stand_number' => ['nullable', 'string', 'max:16'],
            'lines' => ['required', 'array', 'min:1', 'max:200'],
            'lines.*.variant_id' => ['required', 'integer'],
            'lines.*.quantity' => ['required', 'numeric', 'min:0.001'],
            'lines.*.customer_note' => ['nullable', 'string', 'max:255'],
            'lines.*.attribute_value_ids' => ['nullable', 'array'],
            'lines.*.attribute_value_ids.*' => ['integer'],
            'lines.*.combo_parent_uuid' => ['nullable', 'string', 'size:36'],
            'lines.*.combo_item_id' => ['nullable', 'integer'],
        ];
    }
}
