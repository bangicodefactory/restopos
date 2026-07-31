<?php

declare(strict_types=1);

namespace App\Models\Audit;

use App\Enums\NotificationChannel;
use App\Enums\NotificationLogState;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Loyalty\Card;
use App\Models\Pos\NotificationTemplate;
use App\Models\Pos\Order;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Delivery record for receipt e-mails and SMS (spec §2.K).
 *
 * "Did the customer get their receipt?" is a support question that must be
 * answerable without reading mail-server logs. Never sent to any client
 * (spec §5.4).
 */
class NotificationLog extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'notification_logs';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'notification_template_id',
        'pos_order_id',
        'loyalty_card_id',
        'channel',
        'recipient',
        'subject',
        'state',
        'error_message',
        'sent_at',
    ];

    protected function casts(): array
    {
        return [
            'channel' => NotificationChannel::class,
            'state' => NotificationLogState::class,
            'sent_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<NotificationTemplate, $this> */
    public function template(): BelongsTo
    {
        return $this->belongsTo(NotificationTemplate::class, 'notification_template_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<Card, $this> */
    public function loyaltyCard(): BelongsTo
    {
        return $this->belongsTo(Card::class, 'loyalty_card_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeQueued(Builder $query): Builder
    {
        return $query->where('state', NotificationLogState::Queued->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeSent(Builder $query): Builder
    {
        return $query->where('state', NotificationLogState::Sent->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeFailed(Builder $query): Builder
    {
        return $query->whereIn('state', [
            NotificationLogState::Failed->value,
            NotificationLogState::Bounced->value,
        ]);
    }

    /** @param  Builder<static>  $query */
    public function scopeOnChannel(Builder $query, NotificationChannel $channel): Builder
    {
        return $query->where('channel', $channel->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeForRecipient(Builder $query, string $recipient): Builder
    {
        return $query->where('recipient', $recipient);
    }
}
