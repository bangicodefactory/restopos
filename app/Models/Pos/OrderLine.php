<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PriceType;
use App\Models\Catalog\Combo;
use App\Models\Catalog\ComboItem;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductAttributeLineValue;
use App\Models\Catalog\ProductVariant;
use App\Models\Catalog\Uom;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Kitchen\PrepOrderLine;
use App\Models\Loyalty\Card;
use App\Models\Loyalty\Reward;
use App\Models\Restaurant\OrderCourse;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * One sold line (spec §2.F).
 *
 * `quantity` is signed — a refund line is negative. `pos_category_id` is frozen
 * at sale time so kitchen routing survives a later recategorisation, and
 * `tax_signature` is the hash of the applied tax stack, which is what lets the
 * receipt group lines that were taxed identically.
 */
class OrderLine extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'pos_order_lines';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_id',
        'company_id',
        'line_number',
        'product_variant_id',
        'product_id',
        'pos_category_id',
        'full_product_name',
        'uom_id',
        'quantity',
        'price_unit',
        'price_extra',
        'price_type',
        'discount_percent',
        'discount_amount',
        'discount_notice',
        'price_subtotal',
        'price_subtotal_incl',
        'tax_details',
        'tax_signature',
        'unit_cost',
        'total_cost',
        'margin',
        'customer_note',
        'internal_note',
        'combo_parent_line_id',
        'combo_id',
        'combo_item_id',
        'restaurant_course_id',
        'refunded_order_line_id',
        'refunded_quantity',
        'is_reward_line',
        'loyalty_reward_id',
        'loyalty_card_id',
        'reward_identifier_code',
        'points_cost',
        'is_edited',
        'skip_preparation',
        'ui_state',
    ];

    protected function casts(): array
    {
        return [
            'line_number' => 'integer',
            'quantity' => 'decimal:3',
            'price_unit' => 'decimal:4',
            'price_extra' => 'decimal:4',
            'price_type' => PriceType::class,
            'discount_percent' => 'decimal:4',
            'discount_amount' => 'decimal:4',
            'price_subtotal' => 'decimal:4',
            'price_subtotal_incl' => 'decimal:4',
            'tax_details' => AsArrayObject::class,
            'unit_cost' => 'decimal:4',
            'total_cost' => 'decimal:4',
            'margin' => 'decimal:4',
            'internal_note' => AsArrayObject::class,
            'refunded_quantity' => 'decimal:3',
            'is_reward_line' => 'boolean',
            'points_cost' => 'decimal:3',
            'is_edited' => 'boolean',
            'skip_preparation' => 'boolean',
            'ui_state' => AsArrayObject::class,
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<ProductVariant, $this> */
    public function productVariant(): BelongsTo
    {
        return $this->belongsTo(ProductVariant::class, 'product_variant_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id');
    }

    /** Frozen routing category. @return BelongsTo<PosCategory, $this> */
    public function posCategory(): BelongsTo
    {
        return $this->belongsTo(PosCategory::class, 'pos_category_id');
    }

    /** @return BelongsTo<Uom, $this> */
    public function uom(): BelongsTo
    {
        return $this->belongsTo(Uom::class, 'uom_id');
    }

    /** @return BelongsTo<OrderLine, $this> */
    public function comboParentLine(): BelongsTo
    {
        return $this->belongsTo(self::class, 'combo_parent_line_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function comboChildLines(): HasMany
    {
        return $this->hasMany(self::class, 'combo_parent_line_id');
    }

    /** @return BelongsTo<Combo, $this> */
    public function combo(): BelongsTo
    {
        return $this->belongsTo(Combo::class, 'combo_id');
    }

    /** @return BelongsTo<ComboItem, $this> */
    public function comboItem(): BelongsTo
    {
        return $this->belongsTo(ComboItem::class, 'combo_item_id');
    }

    /** @return BelongsTo<OrderCourse, $this> */
    public function course(): BelongsTo
    {
        return $this->belongsTo(OrderCourse::class, 'restaurant_course_id');
    }

    /** @return BelongsTo<OrderLine, $this> */
    public function refundedOrderLine(): BelongsTo
    {
        return $this->belongsTo(self::class, 'refunded_order_line_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function refundLines(): HasMany
    {
        return $this->hasMany(self::class, 'refunded_order_line_id');
    }

    /** `no_variant` attribute values riding on the line. @return BelongsToMany<ProductAttributeLineValue, $this> */
    public function attributeValues(): BelongsToMany
    {
        return $this->belongsToMany(
            ProductAttributeLineValue::class,
            'pos_order_line_attribute_value',
            'pos_order_line_id',
            'product_attribute_line_value_id',
        )->withPivot('price_extra');
    }

    /** @return HasMany<OrderLineCustomAttributeValue, $this> */
    public function customAttributeValues(): HasMany
    {
        return $this->hasMany(OrderLineCustomAttributeValue::class, 'pos_order_line_id');
    }

    /** @return HasMany<InvoiceLine, $this> */
    public function invoiceLines(): HasMany
    {
        return $this->hasMany(InvoiceLine::class, 'pos_order_line_id');
    }

    /** @return HasMany<PrepOrderLine, $this> */
    public function prepLines(): HasMany
    {
        return $this->hasMany(PrepOrderLine::class, 'pos_order_line_id');
    }

    /** @return BelongsTo<Reward, $this> */
    public function loyaltyReward(): BelongsTo
    {
        return $this->belongsTo(Reward::class, 'loyalty_reward_id');
    }

    /** @return BelongsTo<Card, $this> */
    public function loyaltyCard(): BelongsTo
    {
        return $this->belongsTo(Card::class, 'loyalty_card_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopeRewardLines(Builder $query): Builder
    {
        return $query->where('is_reward_line', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeSaleLines(Builder $query): Builder
    {
        return $query->where('is_reward_line', false);
    }

    /** Lines with quantity left to refund. @param  Builder<static>  $query */
    public function scopeRefundable(Builder $query): Builder
    {
        return $query->whereColumn('refunded_quantity', '<', 'quantity');
    }

    /** Combo roots — a line that is not itself a combo child. @param  Builder<static>  $query */
    public function scopeComboParents(Builder $query): Builder
    {
        return $query->whereNull('combo_parent_line_id')->whereNotNull('combo_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForCourse(Builder $query, OrderCourse|int $course): Builder
    {
        return $query->where('restaurant_course_id', $course instanceof OrderCourse ? $course->getKey() : $course);
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('line_number')->orderBy('id');
    }

    // ----------------------------------------------------------------- helpers

    public function isRefundLine(): bool
    {
        return $this->refunded_order_line_id !== null;
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): children of the loaded open orders. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('pos_order_id', Order::posLoadScope($config, $profile)->select('pos_orders.id'))
            ->ordered();
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            // No cost, no margin, no internal notes for an anonymous client (§5.6).
            return [
                'id', 'uuid', 'pos_order_id', 'product_variant_id', 'product_id', 'full_product_name',
                'uom_id', 'quantity', 'price_unit', 'price_extra', 'discount_percent',
                'price_subtotal', 'price_subtotal_incl', 'customer_note', 'combo_parent_line_id',
                'combo_id', 'combo_item_id', 'restaurant_course_id', 'updated_at',
            ];
        }

        return ['*'];
    }
}
