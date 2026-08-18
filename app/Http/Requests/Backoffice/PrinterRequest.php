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
            'is_receipt_printer' => ['sometimes', 'boolean'],
            'print_all_categories' => ['sometimes', 'boolean'],
            'characters_per_line' => ['sometimes', 'integer', 'min:24', 'max:96'],
            'copies' => ['sometimes', 'integer', 'min:1', 'max:5'],
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
