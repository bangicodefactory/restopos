<?php

declare(strict_types=1);

namespace App\Http\Requests\Device;

use App\Enums\DeviceType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** `POST /api/devices/pair` (spec 03 §2.2). */
final class PairDeviceRequest extends FormRequest
{
    public function authorize(): bool
    {
        // The pairing code *is* the authorisation: short, single-use, 10-minute.
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'code' => ['required', 'string', 'min:4', 'max:16'],
            'device_type' => ['nullable', Rule::enum(DeviceType::class)],
            'name' => ['nullable', 'string', 'max:80'],
            'hardware_fingerprint' => ['nullable', 'string', 'max:128'],
            'app_version' => ['nullable', 'string', 'max:32'],
        ];
    }
}
