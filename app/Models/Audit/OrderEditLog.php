<?php

declare(strict_types=1);

namespace App\Models\Audit;

use App\Enums\OrderEditAction;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use App\Models\Pos\OrderLine;
use App\Models\Pos\PosDevice;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Line-level edit trail, written only when `pos_configs.order_edit_tracking` is
 * on (spec §2.K).
 *
 * This is the anti-fraud record: `amount_impact` is what the edit took off (or
 * added to) the ticket, which is what a manager report ranks by.
 * `pos_order_line_uuid` survives the deletion of the line it describes.
 */
class OrderEditLog extends Model
{
    use HasUuid;

    protected $table = 'pos_order_edit_logs';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'pos_order_id',
        'pos_order_line_id',
        'pos_order_line_uuid',
        'action',
        'product_name',
        'old_value',
        'new_value',
        'amount_impact',
        'employee_id',
        'pos_device_id',
        'occurred_at',
    ];

    protected function casts(): array
    {
        return [
            'action' => OrderEditAction::class,
            'amount_impact' => 'decimal:4',
            'occurred_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<OrderLine, $this> */
    public function orderLine(): BelongsTo
    {
        return $this->belongsTo(OrderLine::class, 'pos_order_line_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'employee_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('pos_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfAction(Builder $query, OrderEditAction $action): Builder
    {
        return $query->where('action', $action->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForEmployee(Builder $query, Employee|int $employee): Builder
    {
        return $query->where('employee_id', $employee instanceof Employee ? $employee->getKey() : $employee);
    }

    /** Edits that removed value from the ticket. @param  Builder<static>  $query */
    public function scopeNegativeImpact(Builder $query): Builder
    {
        return $query->where('amount_impact', '<', 0);
    }

    /** @param  Builder<static>  $query */
    public function scopeBetween(Builder $query, \DateTimeInterface|string $from, \DateTimeInterface|string $to): Builder
    {
        return $query->whereBetween('occurred_at', [$from, $to]);
    }
}
