<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use Illuminate\Foundation\Http\FormRequest;

/**
 * `POST /api/pos/employees/verify` — the *online* PIN path.
 *
 * The offline path is the per-device verifier in the bootstrap payload; this
 * endpoint exists for the manager-approval flow, where a signed server answer
 * is worth the round trip (spec 03 §2.3).
 */
final class VerifyEmployeeRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'employee_id' => ['required_without:badge', 'nullable', 'integer'],
            'pin' => ['required_without:badge', 'nullable', 'string', 'max:32'],
            'badge' => ['required_without:pin', 'nullable', 'string', 'max:64'],
            'ability' => ['nullable', 'string', 'max:64'],
        ];
    }
}
