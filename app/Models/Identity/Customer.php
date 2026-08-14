<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Enums\AddressType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Loyalty\Card;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Services\Pos\CustomerAccountLedger;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Guest / account holder (spec §2.A). Addresses are modelled as child rows via
 * `parent_id` + `address_type`, exactly like Odoo's child partners.
 */
class Customer extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'customers';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'address_type' => AddressType::class,
            'is_company' => 'boolean',
            'loyalty_points_cache' => 'decimal:3',
            'account_balance' => 'decimal:4',
            'order_count' => 'integer',
            'last_order_at' => 'datetime',
            'marketing_opt_in' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Customer, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    /** @return HasMany<Customer, $this> */
    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }

    /**
     * The running tab (REG-208), newest first.
     *
     * `account_balance` on this row is the cached head of it. Write through
     * {@see CustomerAccountLedger} only — appending here directly leaves the
     * cache behind and the two silently disagree.
     *
     * @return HasMany<CustomerAccountMove, $this>
     */
    public function accountMoves(): HasMany
    {
        return $this->hasMany(CustomerAccountMove::class)->orderByDesc('occurred_at');
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

    /** @return BelongsTo<Pricelist, $this> */
    public function pricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class);
    }

    /** @return BelongsTo<FiscalPosition, $this> */
    public function fiscalPosition(): BelongsTo
    {
        return $this->belongsTo(FiscalPosition::class);
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /** @return HasMany<Card, $this> */
    public function loyaltyCards(): HasMany
    {
        return $this->hasMany(Card::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeSearch(Builder $query, string $term): Builder
    {
        $like = '%'.$term.'%';

        return $query->where(fn (Builder $q) => $q
            ->where('name', 'like', $like)
            ->orWhere('email', 'like', $like)
            ->orWhere('phone', 'like', $like)
            ->orWhere('mobile', 'like', $like)
            ->orWhere('vat', 'like', $like)
            ->orWhere('barcode', $term));
    }

    /** @param  Builder<static>  $query */
    public function scopeInvoiceAddresses(Builder $query): Builder
    {
        return $query->where('address_type', AddressType::Invoice->value);
    }

    /**
     * Top-N by order count (Odoo's preload ordering — spec §5.3).
     *
     * @return Builder<static>
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where('active', true)
            ->orderByDesc('order_count')
            ->orderBy('name')
            ->limit($config->limited_customer_count);
    }
}
