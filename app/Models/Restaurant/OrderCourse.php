<?php

declare(strict_types=1);

namespace App\Models\Restaurant;

use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Kitchen\PrepOrderLine;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * A course of a sit-down order — "Starters", "Course 2" (spec §2.G).
 *
 * Client-created (hence the `uuid`) and fired to the kitchen course by course.
 * `fired_at` is stamped server-side when `fired` flips true and is immutable
 * from then on; trailing empty unfired courses are compacted away by the
 * service layer, never here.
 */
class OrderCourse extends Model implements PosLoadable
{
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'restaurant_order_courses';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_id',
        'course_index',
        'name',
        'fired',
        'fired_at',
        'line_count',
    ];

    protected function casts(): array
    {
        return [
            'course_index' => 'integer',
            'fired' => 'boolean',
            'fired_at' => 'datetime',
            'line_count' => 'integer',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return HasMany<OrderLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(OrderLine::class, 'restaurant_course_id');
    }

    /** @return HasMany<PrepOrderLine, $this> */
    public function prepLines(): HasMany
    {
        return $this->hasMany(PrepOrderLine::class, 'restaurant_course_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopeFired(Builder $query): Builder
    {
        return $query->where('fired', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeUnfired(Builder $query): Builder
    {
        return $query->where('fired', false);
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('course_index')->orderBy('id');
    }

    // ----------------------------------------------------------------- helpers

    public function displayName(): string
    {
        return $this->name ?? ('Course '.$this->course_index);
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): courses of the loaded open orders. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('pos_order_id', Order::posLoadScope($config, $profile)->select('pos_orders.id'))
            ->ordered();
    }
}
