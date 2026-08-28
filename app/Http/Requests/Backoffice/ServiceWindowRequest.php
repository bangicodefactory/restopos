<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\DayPeriod;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PresetServiceWindow;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * One opening window of a service mode (BOF-113, BAN-429).
 *
 * Hours are stored as `decimal(5,2)` — 18.5 is half past six — which is how Odoo spells an
 * attendance and how the register reads one back. The editor turns a clock time into that number
 * and back; this only has to refuse the ones that mean nothing.
 *
 * A window is not decoration. Once `use_timing` is on, these are the hours during which the preset
 * will accept a booking at all (`PresetSlotService`), so a wrong window closes a delivery service
 * without saying so.
 */
final class ServiceWindowRequest extends FormRequest
{
    public function authorize(): bool
    {
        $preset = $this->route('preset');

        return $preset instanceof PosPreset && $this->user()?->can('update', $preset) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $required = $this->route('window') === null ? 'required' : 'sometimes';

        return [
            // 0 = Monday … 6 = Sunday, matching the column comment and `scopeOnDay`.
            'day_of_week' => [$required, 'integer', 'min:0', 'max:6'],
            'hour_from' => [$required, 'numeric', 'min:0', 'max:24'],
            'hour_to' => [$required, 'numeric', 'min:0', 'max:24'],
            'day_period' => ['sometimes', 'nullable', Rule::enum(DayPeriod::class)],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertWindowIsOrdered($validator);
            $this->assertWindowDoesNotOverlap($validator);
        });
    }

    /** A window that closes before it opens is open for no minutes and reads as open all day. */
    private function assertWindowIsOrdered(Validator $validator): void
    {
        $from = $this->input('hour_from');
        $to = $this->input('hour_to');

        if ($from === null || $to === null) {
            return;
        }

        if ((float) $to <= (float) $from) {
            $validator->errors()->add('hour_to', 'This window would close before it opened, so the mode would take nothing all day.');
        }
    }

    /**
     * Two windows over the same hours on the same day.
     *
     * Nothing crashes — but capacity is counted per *interval*, not per window, so overlapping hours
     * offer the same slot twice on screen while the kitchen has one. Lunch 11–14 and a second row
     * 13–15 is the shape this happens in: it looks like an extension and is a double booking.
     */
    private function assertWindowDoesNotOverlap(Validator $validator): void
    {
        $preset = $this->route('preset');
        $from = $this->input('hour_from');
        $to = $this->input('hour_to');
        $day = $this->input('day_of_week');

        if (! $preset instanceof PosPreset || $from === null || $to === null || $day === null) {
            return;
        }

        $existing = $preset->serviceWindows()
            ->where('day_of_week', (int) $day)
            ->when($this->route('window') instanceof PresetServiceWindow,
                fn ($query) => $query->whereKeyNot($this->route('window')->getKey()))
            ->get();

        foreach ($existing as $window) {
            if ((float) $from < (float) $window->hour_to && (float) $window->hour_from < (float) $to) {
                $validator->errors()->add('hour_from', 'These hours overlap a window already set for this day. Widen that one instead — two windows over the same hours offer the same slot twice.');

                return;
            }
        }
    }
}
