<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\DiscountApplicability;
use App\Enums\DiscountMode;
use App\Enums\LoyaltyRewardType;
use App\Models\Catalog\Product;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * What a program gives back: a discount, a free product, free shipping
 * (spec §2.J).
 *
 * A discount reward materialises as an order line on `discount_line_product_id`
 * so the receipt, the tax engine and the accounting export all see an ordinary
 * negative line rather than a special case.
 */
class Reward extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'loyalty_rewards';

    /** @var list<string> */
    protected $fillable = [
        'loyalty_program_id',
        'reward_type',
        'description',
        'required_points',
        'clear_wallet',
        'discount_value',
        'discount_mode',
        'discount_applicability',
        'discount_max_amount',
        'is_global_discount',
        'discount_line_product_id',
        'reward_product_id',
        'reward_product_quantity',
        'multi_product',
        'sequence',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'reward_type' => LoyaltyRewardType::class,
            'required_points' => 'decimal:3',
            'clear_wallet' => 'boolean',
            'discount_value' => 'decimal:4',
            'discount_mode' => DiscountMode::class,
            'discount_applicability' => DiscountApplicability::class,
            'discount_max_amount' => 'decimal:4',
            'is_global_discount' => 'boolean',
            'reward_product_quantity' => 'decimal:3',
            'multi_product' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class, 'loyalty_program_id');
    }

    /** The special product a discount reward books itself onto. @return BelongsTo<Product, $this> */
    public function discountLineProduct(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'discount_line_product_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function rewardProduct(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'reward_product_id');
    }

    /** The choice set when `multi_product`. @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'loyalty_reward_product', 'loyalty_reward_id', 'product_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function orderLines(): HasMany
    {
        return $this->hasMany(OrderLine::class, 'loyalty_reward_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForProgram(Builder $query, Program|int $program): Builder
    {
        return $query->where('loyalty_program_id', $program instanceof Program ? $program->getKey() : $program);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, LoyaltyRewardType $type): Builder
    {
        return $query->where('reward_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeDiscounts(Builder $query): Builder
    {
        return $query->where('reward_type', LoyaltyRewardType::Discount->value);
    }

    /** Rewards claimable with the given balance. @param  Builder<static>  $query */
    public function scopeAffordable(Builder $query, string|float|int $points): Builder
    {
        return $query->where('required_points', '<=', $points);
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): rewards of the loaded programs. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('loyalty_program_id', Program::posLoadScope($config, $profile)->select('loyalty_programs.id'))
            ->active()
            ->orderBy('sequence');
    }
}
