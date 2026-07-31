<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PaymentMethodType;
use App\Enums\QrCodeMethod;
use App\Enums\TerminalProvider;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * How money is taken (spec §2.D). No accounting journals: an explicit
 * `method_type` plus a free-form `ledger_code` echoed into the export.
 */
class PaymentMethod extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'payment_methods';

    protected $guarded = [];

    protected $hidden = ['terminal_config'];

    protected function casts(): array
    {
        return [
            'method_type' => PaymentMethodType::class,
            'is_cash_count' => 'boolean',
            'identify_customer' => 'boolean',
            'allow_change' => 'boolean',
            'allow_refund' => 'boolean',
            'is_rounding_target' => 'boolean',
            'terminal_provider' => TerminalProvider::class,
            'terminal_config' => 'encrypted:array',
            'qr_code_method' => QrCodeMethod::class,
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsTo<PaymentProvider, $this> */
    public function provider(): BelongsTo
    {
        return $this->belongsTo(PaymentProvider::class, 'payment_provider_id');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_payment_method')
            ->withPivot(['sequence', 'is_fast_payment']);
    }

    /** @return HasMany<Payment, $this> */
    public function payments(): HasMany
    {
        return $this->hasMany(Payment::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeCash(Builder $query): Builder
    {
        return $query->where('method_type', PaymentMethodType::Cash->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeCounted(Builder $query): Builder
    {
        return $query->where('is_cash_count', true);
    }

    public function isCash(): bool
    {
        return $this->method_type === PaymentMethodType::Cash;
    }

    /** Archived methods are still loaded: historical payments reference them (spec §5.3). */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            return static::query()->whereKey($config->self_order_online_payment_method_id);
        }

        return static::query()
            ->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($config->getKey()))
            ->orderBy('sequence');
    }
}
