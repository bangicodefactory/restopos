<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\DenominationType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** A coin/bill denomination used by the drawer count (spec §2.D). */
class PosBill extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pos_bills';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'value' => 'decimal:4',
            'denomination_type' => DenominationType::class,
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_bill');
    }

    /** Bills linked to the config, or global bills (no config link) — spec §5.3. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where('currency_id', $config->currency_id)
            ->where(fn (Builder $q) => $q
                ->whereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey()))
                ->orWhereDoesntHave('posConfigs'))
            ->orderBy('value');
    }
}
