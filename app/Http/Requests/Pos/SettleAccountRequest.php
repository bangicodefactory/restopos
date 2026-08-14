<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Support\Validation\Amount;
use Illuminate\Foundation\Http\FormRequest;

/** `POST /api/pos/customers/{customer}/account/settle` (REG-208). */
final class SettleAccountRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            // The magnitude handed over. The ledger applies the sign, because "positive means owed"
            // is the ledger's invariant to keep and not something a client gets a vote on.
            'amount' => ['required', ...Amount::unsigned()],
            // Required: money that arrives has to say how, or it cannot be made visible to the
            // session that took it.
            'payment_method_id' => ['required', 'integer'],
            'employee_id' => ['nullable', 'integer'],
            'description' => ['nullable', 'string', 'max:160'],
        ];
    }
}
