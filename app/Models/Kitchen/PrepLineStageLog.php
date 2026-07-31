<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrepLineState;
use App\Models\Identity\Employee;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Who moved what, when — the KDS audit trail and the source of prep-time
 * analytics (spec §2.H). Never sent to any client (spec §5.4).
 */
class PrepLineStageLog extends Model
{
    protected $table = 'prep_line_stage_logs';

    /** @var list<string> */
    protected $fillable = [
        'prep_order_line_id',
        'from_stage_id',
        'to_stage_id',
        'from_state',
        'to_state',
        'employee_id',
        'moved_at',
        'duration_seconds',
    ];

    protected function casts(): array
    {
        return [
            'from_state' => PrepLineState::class,
            'to_state' => PrepLineState::class,
            'moved_at' => 'datetime',
            'duration_seconds' => 'integer',
        ];
    }

    /** @return BelongsTo<PrepOrderLine, $this> */
    public function line(): BelongsTo
    {
        return $this->belongsTo(PrepOrderLine::class, 'prep_order_line_id');
    }

    /** @return BelongsTo<PrepStage, $this> */
    public function fromStage(): BelongsTo
    {
        return $this->belongsTo(PrepStage::class, 'from_stage_id');
    }

    /** @return BelongsTo<PrepStage, $this> */
    public function toStage(): BelongsTo
    {
        return $this->belongsTo(PrepStage::class, 'to_stage_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'employee_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForLine(Builder $query, PrepOrderLine|int $line): Builder
    {
        return $query->where('prep_order_line_id', $line instanceof PrepOrderLine ? $line->getKey() : $line);
    }

    /** @param  Builder<static>  $query */
    public function scopeMovedTo(Builder $query, PrepLineState $state): Builder
    {
        return $query->where('to_state', $state->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeBetween(Builder $query, \DateTimeInterface|string $from, \DateTimeInterface|string $to): Builder
    {
        return $query->whereBetween('moved_at', [$from, $to]);
    }
}
