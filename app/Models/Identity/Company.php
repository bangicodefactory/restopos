<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Enums\ReceiptTicketUrlDisplayMode;
use App\Enums\TaxRoundingMethod;
use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Concerns\HasActiveState;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Tax;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Legal entity / brand that owns configs, catalog and money — the root of every
 * tenant scope (spec §2.A).
 */
class Company extends Model
{
    use HasActiveState;
    use HasFactory;

    protected $table = 'companies';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'tax_calculation_rounding_method' => TaxRoundingMethod::class,
            'receipt_ticket_url_display_mode' => ReceiptTicketUrlDisplayMode::class,
            'price_include_default' => 'boolean',
            'receipt_use_ticket_qr' => 'boolean',
            'receipt_ticket_unique_code' => 'boolean',
            'stale_session_alert_days' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsTo<Country, $this> */
    public function country(): BelongsTo
    {
        return $this->belongsTo(Country::class);
    }

    /** @return BelongsTo<CountryState, $this> */
    public function state(): BelongsTo
    {
        return $this->belongsTo(CountryState::class, 'state_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function logo(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'logo_media_id');
    }

    /** @return BelongsTo<BarcodeNomenclature, $this> */
    public function barcodeNomenclature(): BelongsTo
    {
        return $this->belongsTo(BarcodeNomenclature::class);
    }

    /** @return BelongsTo<Customer, $this> */
    public function defaultCustomer(): BelongsTo
    {
        return $this->belongsTo(Customer::class, 'default_customer_id');
    }

    /** @return HasMany<PosConfig, $this> */
    public function posConfigs(): HasMany
    {
        return $this->hasMany(PosConfig::class);
    }

    /** @return HasMany<Employee, $this> */
    public function employees(): HasMany
    {
        return $this->hasMany(Employee::class);
    }

    /** @return HasMany<Customer, $this> */
    public function customers(): HasMany
    {
        return $this->hasMany(Customer::class);
    }

    /** @return HasMany<User, $this> */
    public function users(): HasMany
    {
        return $this->hasMany(User::class);
    }

    /** @return HasMany<Tax, $this> */
    public function taxes(): HasMany
    {
        return $this->hasMany(Tax::class);
    }

    public function roundsGlobally(): bool
    {
        return $this->tax_calculation_rounding_method === TaxRoundingMethod::RoundGlobally;
    }
}
