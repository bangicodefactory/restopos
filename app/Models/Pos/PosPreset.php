<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PresetIdentification;
use App\Enums\PresetServiceAt;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Order mode profile: Dine in / Takeaway / Delivery / Members (spec §2.D).
 * Drives pricelist, fiscal position, required customer info and slot booking.
 */
class PosPreset extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pos_presets';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'identification' => PresetIdentification::class,
            'service_at' => PresetServiceAt::class,
            'is_return' => 'boolean',
            'use_guest' => 'boolean',
            'color' => 'integer',
            'sequence' => 'integer',
            'use_timing' => 'boolean',
            'slots_per_interval' => 'integer',
            'interval_minutes' => 'integer',
            'available_in_self' => 'boolean',
            'is_system' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<PresetServiceWindow, $this> */
    public function serviceWindows(): HasMany
    {
        return $this->hasMany(PresetServiceWindow::class);
    }

    /** @return BelongsTo<Pricelist, $this> */
    public function pricelist(): BelongsTo
    {
        return $this->belongsTo(Pricelist::class);
    }

    /** @return BelongsTo<FiscalPosition, $this> */
    public function fiscalPosition(): BelongsTo
    {
        return $this->belongsTo(FiscalPosition::class);
    }

    /** @return BelongsTo<NotificationTemplate, $this> */
    public function notificationTemplate(): BelongsTo
    {
        return $this->belongsTo(NotificationTemplate::class);
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_preset')->withPivot('sequence');
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeAvailableInSelf(Builder $query): Builder
    {
        return $query->where('available_in_self', true)->where('active', true);
    }

    public function requiresCustomer(): bool
    {
        return $this->identification !== PresetIdentification::None;
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where(fn (Builder $q) => $q
                ->whereKey($config->default_preset_id)
                ->orWhereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey())))
            ->when($profile === PosLoadable::PROFILE_SELF_ORDER, fn (Builder $q) => $q->where('available_in_self', true))
            ->orderBy('sequence');
    }
}
