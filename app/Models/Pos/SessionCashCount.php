<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\CashCountType;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A denomination count event; Odoo kept only the total (spec §2.E, deviation 6). */
class SessionCashCount extends Model
{
    use HasUuid;

    protected $table = 'session_cash_counts';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'count_type' => CashCountType::class,
            'total_counted' => 'decimal:4',
            'counted_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return HasMany<SessionCashCountLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(SessionCashCountLine::class);
    }

    /** @return BelongsTo<Employee, $this> */
    public function countedBy(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'counted_by_employee_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, CashCountType $type): Builder
    {
        return $query->where('count_type', $type->value);
    }

    public function recomputeTotal(): string
    {
        $total = $this->lines->reduce(
            fn (string $carry, SessionCashCountLine $line): string => bcadd($carry, (string) $line->subtotal, 4),
            '0',
        );

        $this->forceFill(['total_counted' => $total])->save();

        return $total;
    }
}
