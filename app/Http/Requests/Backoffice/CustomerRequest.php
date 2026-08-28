<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\AddressType;
use App\Models\Identity\Country;
use App\Models\Identity\CountryState;
use App\Models\Identity\Customer;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * One customer record (BOF-119, BAN-453).
 *
 * The back office had no customer route of any kind, so every field below was writable only by the
 * register's inline picker or not at all. A phone number could not be corrected.
 *
 * ## The two fields that move money
 *
 * `pricelist_id` and `fiscal_position_id` are read at the till the moment the customer is attached
 * to an order — `PricingService::resolvePricelistId` walks order → preset → **customer** → config —
 * so both are ownership-checked through the scoped model rather than `Rule::exists`, which runs on
 * the query builder where `CompanyScope` cannot reach (`ScopedExistsTest`).
 *
 * ## What is not writable here
 *
 * `account_balance`, `loyalty_points_cache`, `order_count` and `last_order_at` are caches over rows
 * this form does not touch. Letting the form write them would let an operator clear a debt by typing
 * over it, with the ledger still saying otherwise — and the ledger is the record
 * (`CustomerAccountLedger`).
 */
final class CustomerRequest extends FormRequest
{
    public function authorize(): bool
    {
        $customer = $this->route('customer');

        return $customer instanceof Customer
            ? $this->user()?->can('update', $customer) === true
            : $this->user()?->can('create', Customer::class) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $customer = $this->route('customer');
        $required = $customer === null ? 'required' : 'sometimes';

        return [
            'name' => [$required, 'string', 'max:160'],
            'is_company' => ['sometimes', 'boolean'],
            'address_type' => ['sometimes', Rule::enum(AddressType::class)],
            'parent_id' => ['sometimes', 'nullable', 'integer', $this->owned(Customer::class)],

            'email' => ['sometimes', 'nullable', 'email:rfc', 'max:160'],
            'phone' => ['sometimes', 'nullable', 'string', 'max:40'],
            'mobile' => ['sometimes', 'nullable', 'string', 'max:40'],
            'vat' => ['sometimes', 'nullable', 'string', 'max:32'],

            'street' => ['sometimes', 'nullable', 'string', 'max:128'],
            'street2' => ['sometimes', 'nullable', 'string', 'max:128'],
            'city' => ['sometimes', 'nullable', 'string', 'max:96'],
            'zip' => ['sometimes', 'nullable', 'string', 'max:24'],
            // Countries and their states are global reference data with no `company_id`, so an
            // unscoped `exists` is the honest rule for these two.
            'country_id' => ['sometimes', 'nullable', 'integer', Rule::exists(Country::class, 'id')],
            'state_id' => ['sometimes', 'nullable', 'integer', Rule::exists(CountryState::class, 'id')],

            // Unique per company, and the column carries that constraint — but a duplicate barcode
            // arrives from the database as a 500 rather than as a field error, so it is checked
            // here first.
            //
            // Through the scoped model, not `Rule::unique`, for the same reason `Rule::exists` is
            // refused on a tenant table: both run on the query builder, which `CompanyScope` cannot
            // reach. `Rule::unique` would look across every tenant and reject a barcode another
            // venue happens to use — the mirror image of the leak `ScopedExistsTest` guards, and
            // just as wrong.
            'barcode' => ['sometimes', 'nullable', 'string', 'max:64', $this->barcodeIsFree()],

            'pricelist_id' => ['sometimes', 'nullable', 'integer', $this->owned(Pricelist::class)],
            'fiscal_position_id' => ['sometimes', 'nullable', 'integer', $this->owned(FiscalPosition::class)],

            'locale' => ['sometimes', 'nullable', 'string', 'max:8'],
            'marketing_opt_in' => ['sometimes', 'boolean'],
            'note' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'active' => ['sometimes', 'boolean'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $this->assertNotItsOwnParent($validator);
            $this->assertReachableIfMarketed($validator);
        });
    }

    /**
     * A customer filed under itself.
     *
     * `parent_id` is how a company's delivery addresses and contacts hang off the company record.
     * Pointing one at itself is accepted by the column and then makes the record its own ancestor —
     * every walk of that chain either loops or stops early depending on which one it is.
     */
    private function assertNotItsOwnParent(Validator $validator): void
    {
        $customer = $this->route('customer');
        $parent = $this->input('parent_id');

        if ($customer instanceof Customer && $parent !== null && (int) $parent === (int) $customer->getKey()) {
            $validator->errors()->add('parent_id', 'A customer cannot be filed under itself.');
        }
    }

    /**
     * Consent with no way to act on it.
     *
     * Marketing opt-in on a record with neither an email nor a mobile is consent that can never be
     * used and, worse, reads as a contactable customer in any count of the marketable base.
     */
    private function assertReachableIfMarketed(Validator $validator): void
    {
        if ($this->boolean('marketing_opt_in') !== true) {
            return;
        }

        $customer = $this->route('customer');

        $email = $this->has('email') ? $this->input('email') : ($customer instanceof Customer ? $customer->email : null);
        $mobile = $this->has('mobile') ? $this->input('mobile') : ($customer instanceof Customer ? $customer->mobile : null);

        if (blank($email) && blank($mobile)) {
            $validator->errors()->add('marketing_opt_in', 'This customer has no email address and no mobile number, so nothing could be sent to them. Record one first.');
        }
    }

    /** No other customer of this venue already carries the barcode. */
    private function barcodeIsFree(): callable
    {
        $customer = $this->route('customer');

        return static function (string $attribute, mixed $value, callable $fail) use ($customer): void {
            if (blank($value)) {
                return;
            }

            $taken = Customer::query()
                ->where('barcode', (string) $value)
                ->when($customer instanceof Customer, fn ($query) => $query->whereKeyNot($customer->getKey()))
                ->exists();

            if ($taken) {
                $fail('Another customer already carries this card.');
            }
        };
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
