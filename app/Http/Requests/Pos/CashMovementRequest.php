<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Enums\CashMovementType;
use App\Support\Validation\Amount;
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
            // Signed, deliberately: the caller sends a magnitude and `SessionService::cashMove`
            // applies the sign from the movement type, but it does that with `ltrim`, which has
            // always tolerated a client sending `-20` for a cash-out. Tightening the shape without
            // tightening that tolerance — the value still has to be something a decimal column can
            // hold, which `1e2` is not (BAN-507).
            'amount' => ['required', ...Amount::signed()],
            'reason' => ['nullable', 'string', 'max:255'],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
