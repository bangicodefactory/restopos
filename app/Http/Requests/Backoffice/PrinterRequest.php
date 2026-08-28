<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\PrinterType;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Creating and editing a kitchen printer (BOF-114, BAN-432).
 *
 * Every column on `pos_printers` except the ones the server owns. `printer_type` and
 * `serial_number` were absent from the old inline rules, which meant a seeded printer could never be
 * repointed at a different transport — the field that decides *how* the device is driven was the one
 * field nobody could change.
 *
 * On create the identity fields are required; on update everything is `sometimes`, so a save from
 * one tab cannot blank a field another tab owns.
 */
final class PrinterRequest extends FormRequest
{
    /**
     * ESC/POS dialects the shared renderer implements
     * ({@see packages/domain/src/escpos/profiles.ts} `PRINTER_PROFILES`). Adding one there without
     * adding it here makes it unselectable; the reverse makes it silently `generic`.
     *
     * @var list<string>
     */
    public const PROFILES = ['generic', 'epson-tm-t20', 'epson-tm-t88', 'star-tsp100', 'bixolon-srp350'];

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $creating = $this->route('printer') === null;
        $required = $creating ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:64'],
            // The transport. Enum-validated rather than free string: an unknown value here is a
            // printer the agent silently never picks up.
            'printer_type' => [$required, Rule::enum(PrinterType::class)],
            'proxy_ip' => ['sometimes', 'nullable', 'string', 'max:64'],
            'printer_ip' => ['sometimes', 'nullable', 'string', 'max:128'],
            'printer_port' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:65535'],
            'serial_number' => ['sometimes', 'nullable', 'string', 'max:64'],
            // The ESC/POS dialect. Unset means `generic`, which is a working printer with the
            // wrong cut and drawer-kick sequences on a model that needs its own.
            // Enum-shaped rather than free text: `resolveProfile()` silently falls back to
            // `generic` on an unknown id, so a typo here would be a printer that keeps working
            // and quietly stops cutting.
            'profile' => ['sometimes', 'nullable', Rule::in(self::PROFILES)],
            // Epson ePOS `devid`. A multi-port TM-i exposes `local_printer2` and up; leaving this
            // unset points every port of the unit at the first roll.
            'epos_device_id' => ['sometimes', 'nullable', 'string', 'max:32'],
            'is_receipt_printer' => ['sometimes', 'boolean'],
            'print_all_categories' => ['sometimes', 'boolean'],
            'characters_per_line' => ['sometimes', 'integer', 'min:24', 'max:96'],
            'copies' => ['sometimes', 'integer', 'min:1', 'max:5'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
            'active' => ['sometimes', 'boolean'],

            'category_ids' => ['sometimes', 'array'],
            // Shape only. *Ownership* is checked in the controller, against the scoped model, and
            // that split is deliberate: `Rule::exists(...)->where('company_id', ...)` cannot express
            // this rule, because a super-admin has no `company_id` and the global scope answers
            // `UNRESTRICTED` for them. Two spellings of one rule is how they drift apart.
            'category_ids.*' => ['integer'],
        ];
    }
}
