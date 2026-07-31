<?php

declare(strict_types=1);

namespace App\Http\Requests\Restaurant;

use App\Enums\TableShape;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Table CRUD + geometry from the floor editor (RST-030…049). */
final class TableRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'restaurant_floor_id' => ['required', 'integer', 'exists:restaurant_floors,id'],
            'table_number' => ['required', 'integer', 'min:0'],
            'name' => ['nullable', 'string', 'max:32'],
            'shape' => ['nullable', Rule::enum(TableShape::class)],
            'position_x' => ['nullable', 'numeric'],
            'position_y' => ['nullable', 'numeric'],
            'width' => ['nullable', 'numeric', 'min:1'],
            'height' => ['nullable', 'numeric', 'min:1'],
            'seats' => ['nullable', 'integer', 'min:1', 'max:999'],
            'color' => ['nullable', 'string', 'max:24'],
            'parent_id' => ['nullable', 'integer', 'exists:restaurant_tables,id'],
            'active' => ['nullable', 'boolean'],
        ];
    }
}
