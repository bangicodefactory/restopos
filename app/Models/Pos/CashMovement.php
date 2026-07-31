<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\CashMovementType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Identity\Employee;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Every non-order movement of physical cash plus the reconciliation artefacts
 * of the close (spec §2.E). `amount` is signed: in = +, out = −.
 * Deletions are soft: Odoo logs the deletion, so do we.
 */
class CashMovement extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'cash_movements';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'movement_type' => CashMovementType::class,
            'amount' => 'decimal:4',
            'moved_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function employee(): BelongsTo
    {
        return $this->belongsTo(Employee::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<Customer, $this> */
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, CashMovementType $type): Builder
    {
        return $query->where('movement_type', $type->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeCashIn(Builder $query): Builder
    {
        return $query->where('amount', '>', 0);
    }

    /** @param  Builder<static>  $query */
    public function scopeCashOut(Builder $query): Builder
    {
        return $query->where('amount', '<', 0);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('pos_session_id', PosSession::posLoadScope($config, $profile)->select('id'));
    }
}
