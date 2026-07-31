<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrepOrderState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * An order as seen by ONE display — the KDS work item (spec §2.H).
 *
 * An order routed to two screens has two rows, each with its own state, so the
 * bar can finish while the kitchen is still cooking. Every label
 * (`table_label`, `preset_label`, `customer_name`) is frozen at fire time: the
 * ticket must not change under the cook's hands.
 */
class PrepOrder extends Model implements PosLoadable
{
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'prep_orders';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'prep_display_id',
        'pos_order_id',
        'pos_config_id',
        'tracking_number',
        'table_label',
        'guest_count',
        'preset_label',
        'customer_name',
        'order_note',
        'state',
        'fired_at',
        'first_started_at',
        'ready_at',
        'served_at',
        'prep_seconds',
        'is_recalled',
        'sequence_in_display',
    ];

    protected function casts(): array
    {
        return [
            'guest_count' => 'integer',
            'state' => PrepOrderState::class,
            'fired_at' => 'datetime',
            'first_started_at' => 'datetime',
            'ready_at' => 'datetime',
            'served_at' => 'datetime',
            'prep_seconds' => 'integer',
            'is_recalled' => 'boolean',
            'sequence_in_display' => 'integer',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<PrepDisplay, $this> */
    public function display(): BelongsTo
    {
        return $this->belongsTo(PrepDisplay::class, 'prep_display_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @return HasMany<PrepOrderLine, $this> */
    public function lines(): HasMany
    {
        return $this->hasMany(PrepOrderLine::class, 'prep_order_id')
            ->orderBy('course_index')
            ->orderBy('id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeForDisplay(Builder $query, PrepDisplay|int $display): Builder
    {
        return $query->where('prep_display_id', $display instanceof PrepDisplay ? $display->getKey() : $display);
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, PrepOrderState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** Still owed to the customer. @param  Builder<static>  $query */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->whereIn('state', [
            PrepOrderState::Pending->value,
            PrepOrderState::InProgress->value,
            PrepOrderState::Ready->value,
        ]);
    }

    /** @param  Builder<static>  $query */
    public function scopeDone(Builder $query): Builder
    {
        return $query->whereIn('state', [PrepOrderState::Served->value, PrepOrderState::Cancelled->value]);
    }

    /**
     * The main board query (spec §5.7): everything open, plus what was served
     * inside the display's retention window so it can still be recalled.
     *
     * @param  Builder<static>  $query
     */
    public function scopeOnBoard(Builder $query, PrepDisplay $display): Builder
    {
        $cutoff = now()->subMinutes($display->done_retention_minutes);

        return $query
            ->forDisplay($display)
            ->where(fn (Builder $q) => $q
                ->whereIn('state', [
                    PrepOrderState::Pending->value,
                    PrepOrderState::InProgress->value,
                    PrepOrderState::Ready->value,
                ])
                ->orWhere('served_at', '>', $cutoff))
            ->orderBy('sequence_in_display')
            ->orderBy('fired_at');
    }

    /** Fired longer ago than the display's late threshold. @param  Builder<static>  $query */
    public function scopeLate(Builder $query, PrepDisplay $display): Builder
    {
        return $query->open()->where('fired_at', '<', now()->subMinutes($display->late_threshold_minutes));
    }

    // ----------------------------------------------------------------- loading

    /** KDS profile (spec §5.7): the config's non-finished boards. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->forConfig($config)->open()->orderBy('fired_at');
    }
}
