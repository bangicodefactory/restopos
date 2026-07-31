<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Enums\CashMovementType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** `POST /api/pos/sessions/{session}/cash-movements` (REG-020…029). */
final class CashMovementRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'uuid' => ['nullable', 'string', 'size:36'],
            'movement_type' => ['required', Rule::in([CashMovementType::CashIn->value, CashMovementType::CashOut->value])],
            'amount' => ['required', 'string'],
            'reason' => ['nullable', 'string', 'max:255'],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
