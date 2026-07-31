<?php

declare(strict_types=1);

namespace App\Http\Requests\Restaurant;

use Illuminate\Foundation\Http\FormRequest;

/** `POST /api/pos/orders/{order}/merge` (RST-055). */
final class MergeOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'target_order_uuid' => ['required', 'string', 'size:36'],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
