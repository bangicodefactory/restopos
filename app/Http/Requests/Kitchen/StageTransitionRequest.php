<?php

declare(strict_types=1);

namespace App\Http\Requests\Kitchen;

use App\Enums\PrepLineState;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** KDS card/line transitions (KDS-008…KDS-010). */
final class StageTransitionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'stage_id' => ['required_without:state', 'nullable', 'integer'],
            'state' => ['required_without:stage_id', 'nullable', Rule::enum(PrepLineState::class)],
            'employee_id' => ['nullable', 'integer'],
        ];
    }
}
