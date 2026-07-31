<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\AmountTaxMode;
use App\Enums\LoyaltyTrigger;
use App\Enums\RewardPointMode;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductTag;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/**
 * An earning / triggering condition of a program (spec §2.J).
 *
 * Odoo's arbitrary `domain` is replaced by explicit product / category / tag
 * pivots so the register can evaluate the rule **offline** — an arbitrary ORM
 * domain is not portable to the client.
 */
class Rule extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'loyalty_rules';

    /** @var list<string> */
    protected $fillable = [
        'loyalty_program_id',
        'mode',
        'code',
        'promo_barcode',
        'minimum_quantity',
        'minimum_amount',
        'minimum_amount_tax_mode',
        'reward_point_amount',
        'reward_point_mode',
        'reward_point_split',
        'applies_to_all_products',
        'sequence',
    ];

    protected function casts(): array
    {
        return [
            'mode' => LoyaltyTrigger::class,
            'minimum_quantity' => 'decimal:3',
            'minimum_amount' => 'decimal:4',
            'minimum_amount_tax_mode' => AmountTaxMode::class,
            'reward_point_amount' => 'decimal:3',
            'reward_point_mode' => RewardPointMode::class,
            'reward_point_split' => 'boolean',
            'applies_to_all_products' => 'boolean',
            'sequence' => 'integer',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class, 'loyalty_program_id');
    }

    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'loyalty_rule_product', 'loyalty_rule_id', 'product_id');
    }

    /** @return BelongsToMany<PosCategory, $this> */
    public function posCategories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'loyalty_rule_pos_category', 'loyalty_rule_id', 'pos_category_id');
    }

    /** @return BelongsToMany<ProductTag, $this> */
    public function productTags(): BelongsToMany
    {
        return $this->belongsToMany(ProductTag::class, 'loyalty_rule_product_tag', 'loyalty_rule_id', 'product_tag_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForProgram(Builder $query, Program|int $program): Builder
    {
        return $query->where('loyalty_program_id', $program instanceof Program ? $program->getKey() : $program);
    }

    /** Rules that fire on their own, without a scanned code. @param  Builder<static>  $query */
    public function scopeAutomatic(Builder $query): Builder
    {
        return $query->where('mode', LoyaltyTrigger::Auto->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeWithCode(Builder $query, string $code): Builder
    {
        return $query->where('mode', LoyaltyTrigger::WithCode->value)
            ->where(fn (Builder $q) => $q->where('code', $code)->orWhere('promo_barcode', $code));
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): rules of the loaded programs. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('loyalty_program_id', Program::posLoadScope($config, $profile)->select('loyalty_programs.id'))
            ->orderBy('sequence');
    }
}
