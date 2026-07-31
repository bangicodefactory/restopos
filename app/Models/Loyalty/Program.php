<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\LoyaltyAppliesOn;
use App\Enums\LoyaltyProgramType;
use App\Enums\LoyaltyTrigger;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Pricelist;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A loyalty / coupon / gift-card / promotion program (spec §2.J).
 *
 * `program_type` decides the whole behaviour; `trigger` decides whether it fires
 * automatically or on a scanned code. An **empty**
 * `loyalty_program_pos_config` pivot means "applies to every register", which is
 * Odoo's semantics.
 */
class Program extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'loyalty_programs';

    /** @var list<string> */
    protected $fillable = [
        'company_id',
        'name',
        'program_type',
        'trigger',
        'applies_on',
        'currency_id',
        'date_from',
        'date_to',
        'limit_usage',
        'max_usage',
        'points_name',
        'is_nominative',
        'is_payment_program',
        'available_in_pos',
        'print_report_on_issue',
        'sequence',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'program_type' => LoyaltyProgramType::class,
            'trigger' => LoyaltyTrigger::class,
            'applies_on' => LoyaltyAppliesOn::class,
            'date_from' => 'date',
            'date_to' => 'date',
            'limit_usage' => 'boolean',
            'max_usage' => 'integer',
            'is_nominative' => 'boolean',
            'is_payment_program' => 'boolean',
            'available_in_pos' => 'boolean',
            'print_report_on_issue' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class, 'currency_id');
    }

    /** @return HasMany<Rule, $this> */
    public function rules(): HasMany
    {
        return $this->hasMany(Rule::class, 'loyalty_program_id')->orderBy('sequence');
    }

    /** @return HasMany<Reward, $this> */
    public function rewards(): HasMany
    {
        return $this->hasMany(Reward::class, 'loyalty_program_id')->orderBy('sequence');
    }

    /** @return HasMany<Card, $this> */
    public function cards(): HasMany
    {
        return $this->hasMany(Card::class, 'loyalty_program_id');
    }

    /** @return HasMany<Communication, $this> */
    public function communications(): HasMany
    {
        return $this->hasMany(Communication::class, 'loyalty_program_id');
    }

    /** @return HasMany<OrderPoint, $this> */
    public function orderPoints(): HasMany
    {
        return $this->hasMany(OrderPoint::class, 'loyalty_program_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'loyalty_program_pos_config', 'loyalty_program_id', 'pos_config_id');
    }

    /** @return BelongsToMany<Pricelist, $this> */
    public function pricelists(): BelongsToMany
    {
        return $this->belongsToMany(Pricelist::class, 'loyalty_program_pricelist', 'loyalty_program_id', 'pricelist_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeAvailableInPos(Builder $query): Builder
    {
        return $query->where('available_in_pos', true)->where('active', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, LoyaltyProgramType $type): Builder
    {
        return $query->where('program_type', $type->value);
    }

    /** Date window covers the given day (null bounds are open). @param  Builder<static>  $query */
    public function scopeCurrent(Builder $query, \DateTimeInterface|string|null $on = null): Builder
    {
        $on ??= now();

        return $query
            ->where(fn (Builder $q) => $q->whereNull('date_from')->orWhere('date_from', '<=', $on))
            ->where(fn (Builder $q) => $q->whereNull('date_to')->orWhere('date_to', '>=', $on));
    }

    /** Global programs (no pivot row) plus the ones bound to this config. */
    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        $id = $config instanceof PosConfig ? $config->getKey() : $config;

        return $query->where(fn (Builder $q) => $q
            ->whereDoesntHave('posConfigs')
            ->orWhereHas('posConfigs', fn (Builder $c) => $c->whereKey($id)));
    }

    // ----------------------------------------------------------------- helpers

    public function isExhausted(): bool
    {
        return $this->limit_usage
            && $this->max_usage !== null
            && $this->cards()->sum('use_count') >= $this->max_usage;
    }

    // ----------------------------------------------------------------- loading

    /**
     * Bootstrap scoping (spec §5.3): available in POS, in scope for this config,
     * matching its currency and inside the date window.
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->availableInPos()
            ->where('currency_id', $config->currency_id)
            ->current()
            ->forConfig($config)
            ->orderBy('sequence');
    }
}
