<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\PresetIdentification;
use App\Enums\PresetServiceAt;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosPreset;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * One service mode (BOF-113, BAN-429).
 *
 * A preset is how a venue distinguishes eat-in from takeaway from delivery, and it decides three
 * things that cost money if they are wrong: which price list applies, which fiscal position rewrites
 * the tax, and what the customer has to identify themselves with.
 *
 * ## Why the ids resolve through the model
 *
 * `pricelists`, `fiscal_positions` and `media_files` all carry a `company_id`, and `Rule::exists`
 * runs on the query builder — the one place `CompanyScope` cannot reach (`ScopedExistsTest`). A
 * preset pointing at another venue's price list would quote their prices on our till.
 *
 * `media_files` is the exception that proves it: shared rows have a null `company_id`, so ownership
 * there means *ours or shared*, and the scoped model already answers exactly that.
 *
 * ## Timing
 *
 * `use_timing` turns a preset into a booking surface — `slots_per_interval` orders per
 * `interval_minutes`. Both are `unsignedSmallInteger` with a default, so zero of either is accepted
 * by the database and then means "no slot is ever free": the preset silently stops taking orders
 * with nothing on screen to say why.
 */
final class PresetRequest extends FormRequest
{
    public function authorize(): bool
    {
        $preset = $this->route('preset');

        return $preset instanceof PosPreset
            ? $this->user()?->can('update', $preset) === true
            : $this->user()?->can('create', PosPreset::class) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $required = $this->route('preset') === null ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:64'],
            'pricelist_id' => ['sometimes', 'nullable', 'integer', $this->owned(Pricelist::class)],
            'fiscal_position_id' => ['sometimes', 'nullable', 'integer', $this->owned(FiscalPosition::class)],
            'image_media_id' => ['sometimes', 'nullable', 'integer', $this->owned(MediaFile::class)],

            'identification' => ['sometimes', Rule::enum(PresetIdentification::class)],
            'service_at' => ['sometimes', Rule::enum(PresetServiceAt::class)],
            'is_return' => ['sometimes', 'boolean'],
            'use_guest' => ['sometimes', 'boolean'],
            'available_in_self' => ['sometimes', 'boolean'],

            'use_timing' => ['sometimes', 'boolean'],
            'slots_per_interval' => ['sometimes', 'integer', 'min:0', 'max:65535'],
            'interval_minutes' => ['sometimes', 'integer', 'min:0', 'max:1440'],

            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertTimingIsUsable($validator);
        });
    }

    /**
     * A booking preset that can never be booked.
     *
     * Both columns default to a workable value, so this only happens when someone clears the field —
     * and then the arithmetic in `PresetSlotService` divides the day into intervals of zero minutes,
     * or offers zero places in each. Either way the preset accepts nothing and says nothing.
     */
    private function assertTimingIsUsable(Validator $validator): void
    {
        if ($this->boolean('use_timing') !== true) {
            return;
        }

        if ($this->has('slots_per_interval') && (int) $this->input('slots_per_interval') < 1) {
            $validator->errors()->add('slots_per_interval', 'With no places in an interval this mode would take no bookings at all. Enter how many orders it can handle at once.');
        }

        if ($this->has('interval_minutes') && (int) $this->input('interval_minutes') < 1) {
            $validator->errors()->add('interval_minutes', 'An interval of zero minutes has no slots in it. Enter how long each booking slot lasts.');
        }
    }

    /**
     * An id that resolves through the scoped model.
     *
     * @param  class-string<Model>  $model
     */
    private function owned(string $model): callable
    {
        return static function (string $attribute, mixed $value, callable $fail) use ($model): void {
            if ($value === null) {
                return;
            }

            if (! $model::query()->whereKey((int) $value)->exists()) {
                $fail('That belongs to another venue, or no longer exists.');
            }
        };
    }
}
