<?php

declare(strict_types=1);

namespace App\Http\Requests\Kitchen;

use Illuminate\Foundation\Http\FormRequest;

/**
 * `POST /api/pos/orders/{order}/preparation` (KDS-056/KDS-057).
 *
 * `snapshot_version` is the cross-device guard: if the server has moved past the
 * version the client believed in, another till already fired this order and we
 * refuse rather than double-firing the kitchen.
 */
final class SendPreparationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'course_index' => ['nullable', 'integer', 'min:1'],
            'snapshot_version' => ['nullable', 'integer', 'min:0'],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
