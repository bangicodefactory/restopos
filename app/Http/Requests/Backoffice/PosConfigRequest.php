<?php

declare(strict_types=1);

namespace App\Http\Requests\Backoffice;

use App\Enums\DefaultScreen;
use App\Enums\TaxDisplay;
use App\Models\Catalog\Product;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosSession;
use App\Models\Pricing\Pricelist;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * Register settings (BOF-031…BOF-044, BAN-466).
 *
 * The inline rule set this replaces listed 29 keys against a table of 81 columns, and Laravel drops
 * silently whatever a rule set omits. So the register's **default pricelist and default fiscal
 * position — the two fields that decide every price the till quotes — could not be set at all**, and
 * neither could cash rounding, the interface toggles or the receipt toggles. The controls existed;
 * they were rendered `disabled` because the front end mirrors this list.
 *
 * Every rule is `sometimes`. The settings screen saves one tab at a time, and a `required` here
 * would let a save from the Payments tab blank a field the Receipts tab owns.
 *
 * **Ownership is resolved through the scoped model, never through `Rule::exists`.** `ActingCompany::id()`
 * returns `'*'` for a super-admin and `null` for a user belonging nowhere, so
 * `exists(...)->where('company_id', ActingCompany::id())` cannot express "mine". Asking the relation
 * for the row instead means the model's own company scope decides, which is the same reasoning as
 * `PosConfigController::ownedIds()` and the ingest-side guard in BAN-520.
 *
 * **Not here, and deliberately:**
 *
 * - `company_id` — re-tenanting a register is not a settings edit. Every session, order and payment
 *   already written against it belongs to the old company; moving the register orphans them.
 * - `access_token`, `config_revision`, `last_config_change_at` — the server owns these. The token is
 *   the device pairing secret.
 * - `self_ordering_*` (BAN-479), the IoT/ePOS block (BAN-476), the media ids (BAN-393),
 *   `fallback_barcode_nomenclature_id` (BAN-488), the loyalty and notification flags (BAN-473,
 *   BAN-475) — each is a tab another ticket owns, and unlocking a field whose surface does not exist
 *   yet is how a switch ends up saving into nothing.
 * - The ticket also lists "ticket QR / `ticket_url_display_mode`" and "unique ticket code" under
 *   BOF-038. Those are `receipt_ticket_url_display_mode` and `receipt_ticket_unique_code` on
 *   **`companies`**, not on `pos_configs` — a company-level receipt setting this controller does not
 *   own. They are not silently dropped; they are somewhere else.
 */
final class PosConfigRequest extends FormRequest
{
    public function authorize(): bool
    {
        $config = $this->route('config');

        return $config instanceof PosConfig && $this->user()?->can('update', $config) === true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $config = $this->config();

        return [
            // ── general ─────────────────────────────────────────────────────────────────────
            'name' => ['sometimes', 'string', 'max:96'],
            'active' => ['sometimes', 'boolean'],
            'currency_id' => ['sometimes', 'integer', Rule::exists('currencies', 'id')],

            // ── catalogue & pricing (BOF-035, BOF-036, BOF-037) ──────────────────────────────
            'use_pricelists' => ['sometimes', 'boolean'],
            'pricelist_id' => ['sometimes', 'nullable', 'integer', $this->owned($config, 'pricelists')],
            'limit_categories' => ['sometimes', 'boolean'],
            'tax_display' => ['sometimes', Rule::enum(TaxDisplay::class)],
            'use_fiscal_positions' => ['sometimes', 'boolean'],
            'default_fiscal_position_id' => ['sometimes', 'nullable', 'integer', $this->owned($config, 'fiscalPositions')],
            'allow_manual_discount' => ['sometimes', 'boolean'],
            'restrict_price_control' => ['sometimes', 'boolean'],
            'show_margins_to_all' => ['sometimes', 'boolean'],

            // ── interface (BOF-034) ─────────────────────────────────────────────────────────
            'show_product_images' => ['sometimes', 'boolean'],
            'show_category_images' => ['sometimes', 'boolean'],
            'group_products_by_category' => ['sometimes', 'boolean'],
            'big_scrollbars' => ['sometimes', 'boolean'],
            'use_employee_login' => ['sometimes', 'boolean'],

            // ── presets & tips (BOF-032) ────────────────────────────────────────────────────
            'use_presets' => ['sometimes', 'boolean'],
            'default_preset_id' => ['sometimes', 'nullable', 'integer', $this->owned($config, 'presets')],
            'enable_tips' => ['sometimes', 'boolean'],
            'tip_after_payment' => ['sometimes', 'boolean'],
            'tip_product_id' => ['sometimes', 'nullable', 'integer', $this->ownedProduct($config)],

            // ── payments (BOF-033) ──────────────────────────────────────────────────────────
            'has_cash_control' => ['sometimes', 'boolean'],
            'set_maximum_difference' => ['sometimes', 'boolean'],
            'amount_authorized_diff' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'auto_validate_terminal_payment' => ['sometimes', 'boolean'],
            'use_fast_payment' => ['sometimes', 'boolean'],
            'use_cash_rounding' => ['sometimes', 'boolean'],
            // Scoped, not `Rule::exists`. `cash_roundings` carries a `company_id` and uses
            // `BelongsToCompany`, so it is every bit as tenant-owned as a pricelist — and
            // `Rule::exists` runs on the query builder, which is precisely what `CompanyScope`
            // says it cannot reach. Probed during review of #95 with an unscoped rule in place:
            // another company's rounding rule attached, 302, no complaint.
            'cash_rounding_id' => ['sometimes', 'nullable', 'integer', $this->owned($config, 'cashRounding')],
            'only_round_cash_payments' => ['sometimes', 'boolean'],

            // ── receipts (BOF-038) ──────────────────────────────────────────────────────────
            'show_receipt_header_footer' => ['sometimes', 'boolean'],
            'receipt_header' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'receipt_footer' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'basic_receipt' => ['sometimes', 'boolean'],
            'auto_print_receipt' => ['sometimes', 'boolean'],
            'skip_receipt_screen' => ['sometimes', 'boolean'],

            // ── restaurant (BOF-041) ────────────────────────────────────────────────────────
            'is_restaurant' => ['sometimes', 'boolean'],
            'enable_split_bill' => ['sometimes', 'boolean'],
            'enable_bill_print' => ['sometimes', 'boolean'],
            'default_screen' => ['sometimes', Rule::enum(DefaultScreen::class)],
            'idle_return_seconds' => ['sometimes', 'integer', 'min:15', 'max:3600'],

            // ── preparation (BOF-039) ───────────────────────────────────────────────────────
            'use_preparation_display' => ['sometimes', 'boolean'],
            'use_preparation_printers' => ['sometimes', 'boolean'],
            'prep_auto_fire_first_course' => ['sometimes', 'boolean'],

            // ── global discount ─────────────────────────────────────────────────────────────
            'enable_global_discount' => ['sometimes', 'boolean'],
            'global_discount_percent' => ['sometimes', 'numeric', 'min:0', 'max:100'],
            'global_discount_product_id' => ['sometimes', 'nullable', 'integer', $this->ownedProduct($config)],

            // ── order audit (BOF-044) ───────────────────────────────────────────────────────
            'order_edit_tracking' => ['sometimes', 'boolean'],

            // ── limits ──────────────────────────────────────────────────────────────────────
            'limited_product_count' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'limited_customer_count' => ['sometimes', 'integer', 'min:1', 'max:100000'],

            // ── pivots ──────────────────────────────────────────────────────────────────────
            //
            // The element rule is `integer` and nothing more. Ownership is settled by
            // `PosConfigController::ownedIds()`, which resolves each id through the scoped relation
            // and refuses — rather than filters — anything that is not ours. Adding an `exists` here
            // as well would report the wrong failure for a foreign id: "does not exist" when it does
            // exist, just not for you.
            ...array_merge(...array_map(
                static fn (string $key): array => [
                    $key => ['sometimes', 'array'],
                    $key.'.*' => ['integer'],
                ],
                [
                    'payment_method_ids', 'pricelist_ids', 'fiscal_position_ids', 'preset_ids',
                    'printer_ids', 'limited_category_ids', 'employee_ids', 'floor_ids',
                    'prep_display_ids', 'note_ids', 'bill_ids',
                ],
            )),
        ];
    }

    /**
     * The rules that need more than one field to be decided.
     */
    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $config = $this->config();

            if ($config === null) {
                return;
            }

            $this->currencyStaysConsistent($validator, $config);
            $this->currencyChangeIsStillPossible($validator, $config);
        });
    }

    /**
     * A pricelist prices in its own currency (BOF-037).
     *
     * Attach one denominated in something else and the till quotes those numbers under this
     * register's currency symbol — 12.00 EUR rendered as £12.00. Nothing downstream converts;
     * `PricingService` reads the pricelist item's amount as-is. So this is not a tidiness rule, it
     * is the difference between the price on the screen and the price the guest is charged.
     *
     * Checked against the currency being *saved*, not the stored one, so a save that changes both
     * the currency and the pricelist in one submit is judged against its own result.
     */
    private function currencyStaysConsistent(Validator $validator, PosConfig $config): void
    {
        $currencyId = (int) ($this->input('currency_id') ?? $config->currency_id);

        $ids = array_filter([
            'pricelist_id' => $this->input('pricelist_id'),
        ]);

        foreach ($ids as $field => $id) {
            $pricelistCurrency = Pricelist::query()
                ->whereKey((int) $id)
                ->value('currency_id');

            if ($pricelistCurrency !== null && (int) $pricelistCurrency !== $currencyId) {
                $validator->errors()->add(
                    $field,
                    'That pricelist prices in a different currency from this register, so the till'
                        .' would quote its amounts under the wrong symbol.',
                );
            }
        }

        foreach ((array) $this->input('pricelist_ids', []) as $index => $id) {
            $pricelistCurrency = Pricelist::query()
                ->whereKey((int) $id)
                ->value('currency_id');

            if ($pricelistCurrency !== null && (int) $pricelistCurrency !== $currencyId) {
                $validator->errors()->add(
                    "pricelist_ids.{$index}",
                    'That pricelist prices in a different currency from this register.',
                );
            }
        }
    }

    /**
     * The register's currency is settled once it has taken money.
     *
     * Every order, payment and session already written against this register records amounts with no
     * currency of their own — they inherit the register's. Change it afterwards and yesterday's
     * takings silently re-denominate: a 40.00 EUR session close reads as 40.00 USD, and the X-report
     * that reconciled cleanly no longer does.
     *
     * The ticket asks for this field to be unlocked, and it is — right up to the first sale.
     */
    private function currencyChangeIsStillPossible(Validator $validator, PosConfig $config): void
    {
        if (! $this->has('currency_id')) {
            return;
        }

        if ((int) $this->input('currency_id') === (int) $config->currency_id) {
            return;
        }

        $hasHistory = Order::query()->where('pos_config_id', $config->getKey())->exists()
            || PosSession::query()->where('pos_config_id', $config->getKey())->exists();

        if ($hasHistory) {
            $validator->errors()->add(
                'currency_id',
                'This register has already taken money. Changing its currency now would re-denominate'
                    .' every session and order it has recorded — create a new register instead.',
            );
        }
    }

    /**
     * An id that must resolve through one of this register's own company-scoped relations.
     *
     * Written as a closure rather than `Rule::exists(...)->where('company_id', ...)` because
     * `ActingCompany::id()` answers `'*'` for a super-admin, which no `where` can express. The
     * relation's `getRelated()->newQuery()` carries the model's global company scope, so a foreign
     * row simply is not there.
     */
    private function owned(?PosConfig $config, string $relation): callable
    {
        return static function (string $attribute, mixed $value, callable $fail) use ($config, $relation): void {
            if ($value === null || $config === null) {
                return;
            }

            // Both halves matter. `newQuery()` carries `CompanyScope`, which is what stops an
            // ordinary user reaching another tenant. The explicit `where` is what stops a
            // *super-admin* — the scope deliberately steps aside for one, and "may cross companies"
            // should not mean "may point this register at another company's pricelist". That is not
            // an authorisation question; a foreign pricelist prices this venue's sales wrongly no
            // matter who attached it.
            $exists = $config->{$relation}()->getRelated()->newQuery()
                ->where('company_id', $config->company_id)
                ->whereKey((int) $value)
                ->exists();

            if (! $exists) {
                $fail('That choice belongs to another venue, or no longer exists.');
            }
        };
    }

    /** Products are reached from the company rather than from a pivot on the register. */
    private function ownedProduct(?PosConfig $config): callable
    {
        return static function (string $attribute, mixed $value, callable $fail) use ($config): void {
            if ($value === null || $config === null) {
                return;
            }

            $exists = Product::query()
                ->where('company_id', $config->company_id)
                ->whereKey((int) $value)
                ->exists();

            if (! $exists) {
                $fail('That product belongs to another venue, or no longer exists.');
            }
        };
    }

    private function config(): ?PosConfig
    {
        $config = $this->route('config');

        return $config instanceof PosConfig ? $config : null;
    }
}
