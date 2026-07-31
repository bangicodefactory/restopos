<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrepChangeType;
use App\Enums\PrepLineState;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\OrderCourse;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One (prep order, order line, fired quantity batch) row (spec §2.H).
 *
 * Quantities are **deltas** and signed: a second fire of the same product
 * creates a second row instead of mutating an already-served one, and a
 * cancellation is a negative row. `pos_order_line_uuid` is kept denormalised so
 * a cancel ticket survives the deletion of its source line.
 */
class PrepOrderLine extends Model implements PosLoadable
{
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'prep_order_lines';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'prep_order_id',
        'pos_order_line_id',
        'pos_order_line_uuid',
        'prep_stage_id',
        'restaurant_course_id',
        'course_index',
        'product_id',
        'pos_category_id',
        'display_name',
        'quantity',
        'change_type',
        'customer_note',
        'internal_note',
        'combo_parent_uuid',
        'state',
        'started_at',
        'ready_at',
        'served_at',
        'fired_at',
    ];

    protected function casts(): array
    {
        return [
            'course_index' => 'integer',
            'quantity' => 'decimal:3',
            'change_type' => PrepChangeType::class,
            'state' => PrepLineState::class,
            'started_at' => 'datetime',
            'ready_at' => 'datetime',
            'served_at' => 'datetime',
            'fired_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<PrepOrder, $this> */
    public function prepOrder(): BelongsTo
    {
        return $this->belongsTo(PrepOrder::class, 'prep_order_id');
    }

    /** Null once the source line has been deleted. @return BelongsTo<OrderLine, $this> */
    public function orderLine(): BelongsTo
    {
        return $this->belongsTo(OrderLine::class, 'pos_order_line_id');
    }

    /** @return BelongsTo<PrepStage, $this> */
    public function stage(): BelongsTo
    {
        return $this->belongsTo(PrepStage::class, 'prep_stage_id');
    }

    /** @return BelongsTo<OrderCourse, $this> */
    public function course(): BelongsTo
    {
        return $this->belongsTo(OrderCourse::class, 'restaurant_course_id');
    }

    /** @return BelongsTo<Product, $this> */
    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id');
    }

    /** @return BelongsTo<PosCategory, $this> */
    public function posCategory(): BelongsTo
    {
        return $this->belongsTo(PosCategory::class, 'pos_category_id');
    }

    /** @return HasMany<PrepLineStageLog, $this> */
    public function stageLogs(): HasMany
    {
        return $this->hasMany(PrepLineStageLog::class, 'prep_order_line_id')->orderBy('moved_at');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForPrepOrder(Builder $query, PrepOrder|int $prepOrder): Builder
    {
        return $query->where('prep_order_id', $prepOrder instanceof PrepOrder ? $prepOrder->getKey() : $prepOrder);
    }

    /** @param  Builder<static>  $query */
    public function scopeForStage(Builder $query, PrepStage|int $stage): Builder
    {
        return $query->where('prep_stage_id', $stage instanceof PrepStage ? $stage->getKey() : $stage);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, PrepLineState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** Not yet served or cancelled. @param  Builder<static>  $query */
    public function scopePending(Builder $query): Builder
    {
        return $query->whereIn('state', [
            PrepLineState::Todo->value,
            PrepLineState::InProgress->value,
            PrepLineState::Ready->value,
        ]);
    }

    /** @param  Builder<static>  $query */
    public function scopeForCourse(Builder $query, int $courseIndex): Builder
    {
        return $query->where('course_index', $courseIndex);
    }

    /** Rows that undo previously-sent quantity. @param  Builder<static>  $query */
    public function scopeCancellations(Builder $query): Builder
    {
        return $query->where('change_type', PrepChangeType::Cancelled->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('course_index')->orderBy('id');
    }

    // ----------------------------------------------------------------- loading

    /** KDS profile (spec §5.7): lines of the loaded boards. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('prep_order_id', PrepOrder::posLoadScope($config, $profile)->select('prep_orders.id'))
            ->ordered();
    }
}
