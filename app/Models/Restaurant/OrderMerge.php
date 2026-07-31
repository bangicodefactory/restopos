<?php

declare(strict_types=1);

namespace App\Models\Restaurant;

use App\Enums\MergeType;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\Pos\Order;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Audit + restore payload for table linking, order transfer, merge and split
 * (spec §2.G).
 *
 * Odoo kept this only in volatile client `uiState`, which is lost on a device
 * change; persisting it is what makes "unmerge" correct across devices.
 * `restore_payload` holds the per-line and per-course state needed to put the
 * absorbed order back exactly where it was.
 */
class OrderMerge extends Model
{
    use HasUuid;

    protected $table = 'pos_order_merges';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'source_order_id',
        'target_order_id',
        'source_table_id',
        'merge_type',
        'restore_payload',
        'prep_history_payload',
        'performed_by_employee_id',
        'performed_at',
        'reverted_at',
    ];

    protected function casts(): array
    {
        return [
            'merge_type' => MergeType::class,
            'restore_payload' => AsArrayObject::class,
            'prep_history_payload' => AsArrayObject::class,
            'performed_at' => 'datetime',
            'reverted_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** The order that was absorbed (soft-deleted afterwards). @return BelongsTo<Order, $this> */
    public function sourceOrder(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'source_order_id');
    }

    /** The surviving order. @return BelongsTo<Order, $this> */
    public function targetOrder(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'target_order_id');
    }

    /** Where to restore the source order to on unmerge. @return BelongsTo<Table, $this> */
    public function sourceTable(): BelongsTo
    {
        return $this->belongsTo(Table::class, 'source_table_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function performedBy(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'performed_by_employee_id');
    }

    // ------------------------------------------------------------------ scopes

    /** Merges that have not been undone — the only ones that can be reverted. */
    /** @param  Builder<static>  $query */
    public function scopePending(Builder $query): Builder
    {
        return $query->whereNull('reverted_at');
    }

    /** @param  Builder<static>  $query */
    public function scopeReverted(Builder $query): Builder
    {
        return $query->whereNotNull('reverted_at');
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, MergeType $type): Builder
    {
        return $query->where('merge_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForTargetOrder(Builder $query, Order|int $order): Builder
    {
        return $query->where('target_order_id', $order instanceof Order ? $order->getKey() : $order);
    }

    public function isReverted(): bool
    {
        return $this->reverted_at !== null;
    }
}
