<?php

declare(strict_types=1);

namespace App\Models\Loyalty;

use App\Enums\LoyaltyCommunicationTrigger;
use App\Models\Pos\NotificationTemplate;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * "Send this template when …" — card creation, a points threshold, an
 * approaching expiry (spec §2.J).
 */
class Communication extends Model
{
    protected $table = 'loyalty_communications';

    /** @var list<string> */
    protected $fillable = [
        'loyalty_program_id',
        'trigger',
        'points_threshold',
        'notification_template_id',
    ];

    protected function casts(): array
    {
        return [
            'trigger' => LoyaltyCommunicationTrigger::class,
            'points_threshold' => 'decimal:3',
        ];
    }

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class, 'loyalty_program_id');
    }

    /** @return BelongsTo<NotificationTemplate, $this> */
    public function template(): BelongsTo
    {
        return $this->belongsTo(NotificationTemplate::class, 'notification_template_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeForProgram(Builder $query, Program|int $program): Builder
    {
        return $query->where('loyalty_program_id', $program instanceof Program ? $program->getKey() : $program);
    }

    /** @param  Builder<static>  $query */
    public function scopeOnTrigger(Builder $query, LoyaltyCommunicationTrigger $trigger): Builder
    {
        return $query->where('trigger', $trigger->value);
    }
}
