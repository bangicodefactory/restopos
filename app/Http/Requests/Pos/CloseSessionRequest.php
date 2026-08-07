<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Support\Validation\Amount;
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
            // The drawer's contents: `bcsub` against expected cash, and a drawer holds no negative
            // notes. Unvalidated, `1e2` reached bcmath and 500'd the close (BAN-507).
            'counted_cash' => ['nullable', ...Amount::unsigned()],
            'counted_by_method' => ['nullable', 'array'],
            // Signed, unlike the cash: a payment method whose refunds outrun its takings expects a
            // negative total — a customer returning tomorrow with yesterday's receipt is enough —
            // and the close screen pre-fills the counted amount from that expectation. A floor here
            // would refuse an ordinary close.
            'counted_by_method.*' => Amount::signed(),
            'denominations' => ['nullable', 'array'],
            'denominations.*.denomination_value' => ['required_with:denominations', ...Amount::unsigned()],
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
