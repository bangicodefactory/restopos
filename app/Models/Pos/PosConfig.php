<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\DefaultScreen;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\SessionState;
use App\Enums\TaxDisplay;
use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\Identity\Language;
use App\Models\Identity\MediaFile;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Loyalty\Program;
use App\Models\Pricing\CashRounding;
use App\Models\Pricing\Currency;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Models\Restaurant\Floor;
use App\Models\SelfOrder\CustomLink;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Str;

/**
 * One register / terminal profile — the widest table in the schema, because it
 * is Odoo's `pos.config` and everything about a register's behaviour hangs off
 * it (spec §2.D).
 *
 * `access_token` doubles as the broadcast channel name
 * (`pos.config.{access_token}` — the name `routes/channels.php` authorises and
 * every `broadcastOn()` builds) and as the self-order entry token (§6.6).
 * `config_revision` is bumped whenever anything client-visible changes; a client
 * whose stored revision differs discards its cache and re-bootstraps (§5.5).
 */
class PosConfig extends Model
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use SoftDeletes;

    protected $table = 'pos_configs';

    protected $guarded = [];

    protected $hidden = ['access_token'];

    protected function casts(): array
    {
        return [
            'use_cash_rounding' => 'boolean',
            'only_round_cash_payments' => 'boolean',
            'config_revision' => 'integer',
            'last_config_change_at' => 'datetime',
            'active' => 'boolean',

            'use_pricelists' => 'boolean',
            'limit_categories' => 'boolean',
            'tax_display' => TaxDisplay::class,
            'use_fiscal_positions' => 'boolean',
            'show_product_images' => 'boolean',
            'show_category_images' => 'boolean',
            'group_products_by_category' => 'boolean',
            'allow_manual_discount' => 'boolean',
            'restrict_price_control' => 'boolean',
            'show_margins_to_all' => 'boolean',

            'use_presets' => 'boolean',
            'enable_tips' => 'boolean',
            'tip_after_payment' => 'boolean',

            'has_cash_control' => 'boolean',
            'set_maximum_difference' => 'boolean',
            'amount_authorized_diff' => 'decimal:4',
            'auto_validate_terminal_payment' => 'boolean',
            'use_fast_payment' => 'boolean',

            'show_receipt_header_footer' => 'boolean',
            'basic_receipt' => 'boolean',
            'auto_print_receipt' => 'boolean',
            'skip_receipt_screen' => 'boolean',

            'is_restaurant' => 'boolean',
            'enable_split_bill' => 'boolean',
            'enable_bill_print' => 'boolean',
            'default_screen' => DefaultScreen::class,
            'idle_return_seconds' => 'integer',

            'use_preparation_printers' => 'boolean',
            'use_preparation_display' => 'boolean',
            'prep_auto_fire_first_course' => 'boolean',

            'use_iot_box' => 'boolean',
            'iot_scan' => 'boolean',
            'iot_scale' => 'boolean',
            'iot_print' => 'boolean',
            'iot_cashdrawer' => 'boolean',
            'use_epos_printer' => 'boolean',
            'big_scrollbars' => 'boolean',

            'self_ordering_mode' => SelfOrderMode::class,
            'self_ordering_service_mode' => SelfOrderServiceMode::class,
            'self_ordering_pay_after' => SelfOrderPayAfter::class,
            'kiosk_idle_seconds' => 'integer',
            'kiosk_confirmation_seconds' => 'integer',

            'enable_global_discount' => 'boolean',
            'global_discount_percent' => 'decimal:4',

            'use_employee_login' => 'boolean',
            'enable_loyalty' => 'boolean',
            'enable_sms_receipt' => 'boolean',
            'order_edit_tracking' => 'boolean',
            'role_abilities' => 'array',
            'limited_product_count' => 'integer',
            'limited_customer_count' => 'integer',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsTo<CashRounding, $this> */
    public function cashRounding(): BelongsTo
    {
        return $this->belongsTo(CashRounding::class);
    }

    /** @return BelongsTo<Pricelist, $this> */
    public function pricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class);
    }

    /** @return BelongsToMany<Pricelist, $this> */
    public function pricelists(): BelongsToMany
    {
        return $this->belongsToMany(Pricelist::class, 'pos_config_pricelist');
    }

    /** @return BelongsTo<FiscalPosition, $this> */
    public function defaultFiscalPosition(): BelongsTo
    {
        return $this->belongsTo(FiscalPosition::class, 'default_fiscal_position_id');
    }

    /** @return BelongsToMany<FiscalPosition, $this> */
    public function fiscalPositions(): BelongsToMany
    {
        return $this->belongsToMany(FiscalPosition::class, 'pos_config_fiscal_position');
    }

    /** @return BelongsToMany<PaymentMethod, $this> */
    public function paymentMethods(): BelongsToMany
    {
        return $this->belongsToMany(PaymentMethod::class, 'pos_config_payment_method')
            ->withPivot(['sequence', 'is_fast_payment'])
            ->orderBy('pos_config_payment_method.sequence');
    }

    /** @return BelongsTo<PaymentMethod, $this> */
    public function selfOrderOnlinePaymentMethod(): BelongsTo
    {
        return $this->belongsTo(PaymentMethod::class, 'self_order_online_payment_method_id');
    }

    /** @return BelongsTo<PosPreset, $this> */
    public function defaultPreset(): BelongsTo
    {
        return $this->belongsTo(PosPreset::class, 'default_preset_id');
    }

    /** @return BelongsToMany<PosPreset, $this> */
    public function presets(): BelongsToMany
    {
        return $this->belongsToMany(PosPreset::class, 'pos_config_preset')
            ->withPivot('sequence')
            ->orderBy('pos_config_preset.sequence');
    }

    /** @return BelongsToMany<PosPrinter, $this> */
    public function printers(): BelongsToMany
    {
        return $this->belongsToMany(PosPrinter::class, 'pos_config_printer');
    }

    /** @return BelongsToMany<PosNote, $this> */
    public function notes(): BelongsToMany
    {
        return $this->belongsToMany(PosNote::class, 'pos_config_note');
    }

    /** @return BelongsToMany<PosBill, $this> */
    public function bills(): BelongsToMany
    {
        return $this->belongsToMany(PosBill::class, 'pos_config_bill');
    }

    /** Categories the register is limited to (only when `limit_categories`). */
    /** @return BelongsToMany<PosCategory, $this> */
    public function limitedCategories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'pos_config_pos_category');
    }

    /** Registers that share open orders (bidirectional — the app writes both rows). */
    /** @return BelongsToMany<PosConfig, $this> */
    public function trustedConfigs(): BelongsToMany
    {
        return $this->belongsToMany(self::class, 'pos_config_trusted_config', 'pos_config_id', 'trusted_config_id');
    }

    /**
     * The configs whose orders this one may read: itself plus its trusted peers **in its own company**.
     *
     * A till is not an island. Two registers on the same counter serve one floor, so "look up the
     * order I took ten minutes ago" fails from the second till if the query is pinned to one config
     * — which is exactly what the ticket-screen lookup used to do (REG-293).
     *
     * The company filter is not belt-and-braces. `pos_config_trusted_config` is application-written
     * data, so on its own it is not a tenant boundary: one row pointing at another company's
     * register would hand that company's orders — payments, cardholder names and all — to this one.
     * `OrderSyncService::isWritableBy` checks `company_id` before it consults the pivot for exactly
     * this reason, and a read path that widens the same way has to carry the same guard.
     *
     * `CompanyScope` does not cover this: it keys on the `web` guard, and device requests have no
     * web user by design.
     *
     * `Order::posLoadScope`, `DeltaService::orderDelta` and `OrderSyncService::isWritableBy` each
     * build this set inline; they are correct as they stand, so they are left alone here rather than
     * refactored under a bug fix.
     *
     * @return list<int>
     */
    public function visibleConfigIds(): array
    {
        return [
            (int) $this->getKey(),
            ...$this->trustedConfigs()
                ->where('pos_configs.company_id', $this->company_id)
                ->pluck('pos_configs.id')
                ->map(static fn (mixed $id): int => (int) $id)
                ->all(),
        ];
    }

    /** @return BelongsToMany<Floor, $this> */
    public function floors(): BelongsToMany
    {
        return $this->belongsToMany(Floor::class, 'pos_config_floor', 'pos_config_id', 'restaurant_floor_id');
    }

    /** @return BelongsToMany<Language, $this> */
    public function languages(): BelongsToMany
    {
        return $this->belongsToMany(Language::class, 'pos_config_language')
            ->withPivot('sequence');
    }

    /** @return BelongsToMany<PrepDisplay, $this> */
    public function prepDisplays(): BelongsToMany
    {
        return $this->belongsToMany(PrepDisplay::class, 'pos_config_prep_display');
    }

    /** @return BelongsToMany<CustomLink, $this> */
    public function selfOrderLinks(): BelongsToMany
    {
        return $this->belongsToMany(CustomLink::class, 'pos_config_self_order_custom_link', 'pos_config_id', 'self_order_custom_link_id');
    }

    /** @return BelongsToMany<Employee, $this> */
    public function employees(): BelongsToMany
    {
        return $this->belongsToMany(Employee::class, 'pos_config_employee')
            ->withPivot('access_level')
            ->withTimestamps();
    }

    /** @return BelongsToMany<Program, $this> */
    public function loyaltyPrograms(): BelongsToMany
    {
        return $this->belongsToMany(Program::class, 'loyalty_program_pos_config', 'pos_config_id', 'loyalty_program_id');
    }

    /** @return HasMany<PosDevice, $this> */
    public function devices(): HasMany
    {
        return $this->hasMany(PosDevice::class);
    }

    /** @return HasMany<Sequence, $this> */
    public function sequences(): HasMany
    {
        return $this->hasMany(Sequence::class);
    }

    /** @return HasMany<PosSession, $this> */
    public function sessions(): HasMany
    {
        return $this->hasMany(PosSession::class);
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /** The single non-closed session, enforced by a partial unique index. */
    /** @return HasOne<PosSession, $this> */
    public function currentSession(): HasOne
    {
        return $this->hasOne(PosSession::class)
            ->where('state', '!=', SessionState::Closed->value)
            ->where('is_rescue', false);
    }

    /** @return BelongsTo<Product, $this> */
    public function tipProduct(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'tip_product_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function globalDiscountProduct(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'global_discount_product_id');
    }

    /** @return BelongsTo<BarcodeNomenclature, $this> */
    public function fallbackBarcodeNomenclature(): BelongsTo
    {
        return $this->belongsTo(BarcodeNomenclature::class, 'fallback_barcode_nomenclature_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function customerDisplayBackground(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'customer_display_bg_media_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function selfOrderBrandImage(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'self_ordering_brand_media_id');
    }

    /** @return BelongsTo<NotificationTemplate, $this> */
    public function emailReceiptTemplate(): BelongsTo
    {
        return $this->belongsTo(NotificationTemplate::class, 'email_receipt_template_id');
    }

    /** @return BelongsTo<NotificationTemplate, $this> */
    public function smsTemplate(): BelongsTo
    {
        return $this->belongsTo(NotificationTemplate::class, 'sms_template_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeRestaurants(Builder $query): Builder
    {
        return $query->where('is_restaurant', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeSelfOrderEnabled(Builder $query): Builder
    {
        return $query->where('self_ordering_mode', '!=', SelfOrderMode::Nothing->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeWithOpenSession(Builder $query): Builder
    {
        return $query->whereHas('sessions', fn (Builder $q) => $q->where('state', '!=', SessionState::Closed->value));
    }

    // ----------------------------------------------------------------- helpers

    /*
     * `channelName()` used to live here, returning `pos-config.{access_token}` — a HYPHEN, against
     * an authorizer and nine `broadcastOn()` calls that all say `pos.config.`. It matched nothing.
     * Its only caller shipped it to every till as the bootstrap payload's `channel`, which no
     * client has ever read, so the mismatch could not surface: a wrong name that is never
     * subscribed with fails silently forever.
     *
     * Deleted rather than corrected. `access_token` is already on the register's config row, and a
     * channel name built where it is subscribed with (`register/realtime.ts`) is one a test can
     * catch; a second copy on the model is only somewhere for the two to drift apart again.
     */

    public function hasOpenSession(): bool
    {
        return $this->sessions()
            ->where('state', '!=', SessionState::Closed->value)
            ->exists();
    }

    /** Any client-visible change bumps the revision so devices re-bootstrap. */
    public function bumpRevision(): void
    {
        $this->forceFill([
            'config_revision' => $this->config_revision + 1,
            'last_config_change_at' => now(),
        ])->save();
    }

    public static function newAccessToken(): string
    {
        return Str::lower(Str::random(32));
    }
}
