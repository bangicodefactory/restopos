<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Models\Pos\PosConfig;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Opening a new register (BAN-472).
 *
 * A separate class from {@see PosConfigRequest} rather than a `creating` flag on it, because that
 * request is structurally unable to serve a create: its `authorize()` resolves the policy against
 * the route-bound config, and every ownership rule on it closes over that same config to decide what
 * "ours" means. On a `POST` there is no config yet, so `authorize()` would refuse and every
 * ownership check would short-circuit on null — a rule set that quietly validates nothing.
 *
 * Only the three fields a register cannot exist without. Everything else has a column default and is
 * edited afterwards on the settings screen, which is the surface built for it — asking for eighty
 * columns before a venue has taken a single sale is how a create form becomes something people avoid.
 */
final class CreatePosConfigRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('create', PosConfig::class) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:96'],
            // Currencies are global ISO reference data with no `company_id`, so an unscoped `exists`
            // is the honest rule — unlike every company-owned table, where `Rule::exists` would run
            // on the query builder and slip past `CompanyScope` entirely (see `ScopedExistsTest`).
            'currency_id' => ['required', 'integer', Rule::exists('currencies', 'id')],
            'is_restaurant' => ['sometimes', 'boolean'],
        ];
    }

    /** The company the register is opened in, or null when the caller belongs nowhere. */
    public function companyId(): ?int
    {
        $companyId = ActingCompany::id();

        return is_int($companyId) ? $companyId : null;
    }
}
