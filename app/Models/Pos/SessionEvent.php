<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\SessionEventType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One typed step in a session's life (REG-024).
 *
 * Append-only by intent: there is no update path and no soft delete, because the value of this
 * table is that it says what happened rather than what is currently true. `pos_sessions.state`
 * already holds the latter.
 */
final class SessionEvent extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'session_events';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'event_type' => SessionEventType::class,
            'payload' => 'array',
            'occurred_at' => 'datetime',
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

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }
}
