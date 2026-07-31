<?php

declare(strict_types=1);

namespace App\Http\Requests\Restaurant;

use Illuminate\Foundation\Http\FormRequest;

/** `POST /api/pos/orders/{order}/transfer` (RST-054). */
final class TransferOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'table_id' => ['required', 'integer', 'exists:restaurant_tables,id'],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
