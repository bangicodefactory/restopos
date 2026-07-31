<?php

declare(strict_types=1);

namespace App\Models\Audit;

use App\Enums\AuditSeverity;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\Employee;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\MorphTo;

/**
 * A single polymorphic trail replacing Odoo's chatter (spec §2.K).
 *
 * Never sent to any client (spec §5.4). `changes` holds the `{field: [old,
 * new]}` diff; the actor may be a back-office user, a POS employee, or neither
 * (a scheduled job).
 */
class AuditLog extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'audit_logs';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'pos_config_id',
        'pos_session_id',
        'subject_type',
        'subject_id',
        'event',
        'severity',
        'actor_user_id',
        'actor_employee_id',
        'pos_device_id',
        'message',
        'changes',
        'ip_address',
        'occurred_at',
    ];

    protected function casts(): array
    {
        return [
            'subject_id' => 'integer',
            'severity' => AuditSeverity::class,
            'changes' => AsArrayObject::class,
            'occurred_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return MorphTo<Model, $this> */
    public function subject(): MorphTo
    {
        return $this->morphTo('subject');
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @return BelongsTo<PosSession, $this> */
    public function session(): BelongsTo
    {
        return $this->belongsTo(PosSession::class, 'pos_session_id');
    }

    /** @return BelongsTo<User, $this> */
    public function actorUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }

    /** @return BelongsTo<Employee, $this> */
    public function actorEmployee(): BelongsTo
    {
        return $this->belongsTo(Employee::class, 'actor_employee_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForSubject(Builder $query, Model $subject): Builder
    {
        return $query
            ->where('subject_type', $subject->getMorphClass())
            ->where('subject_id', $subject->getKey());
    }

    /** @param  Builder<static>  $query */
    public function scopeOfEvent(Builder $query, string $event): Builder
    {
        return $query->where('event', $event);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfSeverity(Builder $query, AuditSeverity $severity): Builder
    {
        return $query->where('severity', $severity->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForSession(Builder $query, PosSession|int $session): Builder
    {
        return $query->where('pos_session_id', $session instanceof PosSession ? $session->getKey() : $session);
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeBetween(Builder $query, \DateTimeInterface|string $from, \DateTimeInterface|string $to): Builder
    {
        return $query->whereBetween('occurred_at', [$from, $to]);
    }
}
