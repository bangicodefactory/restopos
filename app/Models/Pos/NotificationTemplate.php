<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\NotificationChannel;
use App\Enums\NotificationPurpose;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Identity\Language;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Email/SMS body for receipts, self-order confirmations and gift cards (spec §2.D). */
class NotificationTemplate extends Model
{
    use BelongsToCompany;
    use HasActiveState;

    protected $table = 'notification_templates';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'channel' => NotificationChannel::class,
            'purpose' => NotificationPurpose::class,
            'attach_receipt_image' => 'boolean',
            'attach_invoice_pdf' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Language, $this> */
    public function language(): BelongsTo
    {
        return $this->belongsTo(Language::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeForPurpose(Builder $query, NotificationPurpose $purpose): Builder
    {
        return $query->where('purpose', $purpose->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeOnChannel(Builder $query, NotificationChannel $channel): Builder
    {
        return $query->where('channel', $channel->value);
    }
}
