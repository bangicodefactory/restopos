<?php

declare(strict_types=1);

namespace App\Http\Requests\Restaurant;

use App\Enums\TableShape;
use App\Models\Identity\MediaFile;
use App\Models\Scopes\CompanyScope;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

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
            // Required on create, `sometimes` on update: a save from the colour picker must not
            // blank the name because that form did not render it (BAN-439).
            'name' => [$this->route('floor') === null ? 'required' : 'sometimes', 'string', 'max:64'],
            'background_color' => ['nullable', 'string', 'max:24'],
            // The upload pipeline exists now (BAN-393). Scoped through the model rather than
            // `Rule::exists`, because `media_files` carries a `company_id` and `Rule::exists` runs
            // on the query builder — the one place `CompanyScope` cannot reach. A NULL company is a
            // genuinely shared asset and stays allowed.
            'background_media_id' => ['sometimes', 'nullable', 'integer', static function (string $attribute, mixed $value, callable $fail): void {
                if ($value === null) {
                    return;
                }

                $ours = MediaFile::query()->whereKey((int) $value)->exists()
                    || MediaFile::query()
                        ->withoutGlobalScope(CompanyScope::class)
                        ->whereKey((int) $value)
                        ->whereNull('company_id')
                        ->exists();

                if (! $ours) {
                    $fail('That image belongs to another venue, or no longer exists.');
                }
            }],

            'sequence' => ['nullable', 'integer'],
            'active' => ['nullable', 'boolean'],

            // The floor editor submits the whole plan with the floor (BOF-115): the full geometry,
            // new tables (client ids < 0) and — by omission — deletions. `id` is the client's id,
            // negative for a table that exists only in the browser. `parent_id` may point at another
            // table in this same payload (including a new one), so it cannot use an `exists` rule;
            // the controller resolves and cycle-checks it. `identifier` and `restaurant_floor_id`
            // are never client-writable here — the token is rotated by its own action, the floor is
            // the route.
            'tables' => ['sometimes', 'array'],
            'tables.*.id' => ['required', 'integer'],
            'tables.*.uuid' => ['nullable', 'string', 'max:64'],
            'tables.*.table_number' => ['required', 'integer', 'min:0'],
            'tables.*.name' => ['nullable', 'string', 'max:32'],
            'tables.*.shape' => ['nullable', Rule::enum(TableShape::class)],
            'tables.*.position_x' => ['nullable', 'numeric'],
            'tables.*.position_y' => ['nullable', 'numeric'],
            'tables.*.width' => ['nullable', 'numeric', 'min:1'],
            'tables.*.height' => ['nullable', 'numeric', 'min:1'],
            'tables.*.seats' => ['nullable', 'integer', 'min:0', 'max:999'],
            'tables.*.color' => ['nullable', 'string', 'max:24'],
            'tables.*.parent_id' => ['nullable', 'integer'],
            'tables.*.active' => ['nullable', 'boolean'],
        ];
    }
}
