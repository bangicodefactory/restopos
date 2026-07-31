<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use Illuminate\Foundation\Http\FormRequest;

/**
 * `POST /api/pos/sessions/{session}/close`.
 *
 * `manager_pin` is what unlocks an over-threshold variance: the difference is
 * computed server-side and refused unless a manager PIN verifies (spec 02
 * REG-030…039).
 */
final class CloseSessionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'counted_cash' => ['nullable', 'string'],
            'counted_by_method' => ['nullable', 'array'],
            'counted_by_method.*' => ['string'],
            'denominations' => ['nullable', 'array'],
            'denominations.*.denomination_value' => ['required_with:denominations', 'string'],
            'denominations.*.quantity' => ['required_with:denominations', 'integer', 'min:0'],
            'denominations.*.pos_bill_id' => ['nullable', 'integer'],
            'employee_id' => ['nullable', 'integer'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'manager_employee_id' => ['nullable', 'integer'],
            'manager_pin' => ['nullable', 'string', 'max:32'],
            'force' => ['nullable', 'boolean'],
        ];
    }
}
