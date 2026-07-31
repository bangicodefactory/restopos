<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use Illuminate\Foundation\Http\FormRequest;

/** `POST /api/pos/sessions` — open with an optional opening control. */
final class OpenSessionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'opening_float' => ['nullable', 'string'],
            'employee_id' => ['nullable', 'integer'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'denominations' => ['nullable', 'array'],
            'denominations.*.denomination_value' => ['required_with:denominations', 'string'],
            'denominations.*.quantity' => ['required_with:denominations', 'integer', 'min:0'],
            'denominations.*.pos_bill_id' => ['nullable', 'integer'],
        ];
    }
}
