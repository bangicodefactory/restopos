<?php

declare(strict_types=1);

namespace App\Http\Requests\Device;

use App\Enums\DeviceType;
use App\Models\Pos\PosConfig;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/** Back-office: mint a pairing code for a register/display/kiosk. */
final class CreatePairingCodeRequest extends FormRequest
{
    public function authorize(): bool
    {
        $config = $this->route('config');

        return $config instanceof PosConfig && $this->user()?->can('pairDevice', $config) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'device_type' => ['required', Rule::enum(DeviceType::class)],
            'name' => ['nullable', 'string', 'max:80'],
        ];
    }
}
