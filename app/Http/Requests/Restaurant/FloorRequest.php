<?php

declare(strict_types=1);

namespace App\Http\Requests\Restaurant;

use Illuminate\Foundation\Http\FormRequest;

/** Floor CRUD from the back-office floor editor (RST-030…049). */
final class FloorRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:64'],
            'background_color' => ['nullable', 'string', 'max:24'],
            'sequence' => ['nullable', 'integer'],
            'active' => ['nullable', 'boolean'],
        ];
    }
}
