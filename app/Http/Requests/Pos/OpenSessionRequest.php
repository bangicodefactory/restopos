<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Support\Validation\Amount;
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
            // `decimal` rather than `numeric`: the float lands in bcmath and in a decimal column,
            // and `numeric` accepts `1e2`, which bcmath throws on (BAN-413). Unsigned because a
            // drawer holds no negative cash, and since BAN-417 this value carries over from the
            // previous close — so one bad number would seed every session after it.
            'opening_float' => ['nullable', ...Amount::unsigned()],
            'employee_id' => ['nullable', 'integer'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'denominations' => ['nullable', 'array'],
            // `recordCount` multiplies this by the quantity, so it reaches bcmath too (BAN-507).
            'denominations.*.denomination_value' => ['required_with:denominations', ...Amount::unsigned()],
            'denominations.*.quantity' => ['required_with:denominations', 'integer', 'min:0'],
            'denominations.*.pos_bill_id' => ['nullable', 'integer'],
        ];
    }
}
