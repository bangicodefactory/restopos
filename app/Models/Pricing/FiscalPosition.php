<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Country;
use App\Models\Identity\CountryState;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Tax mapping profile: takeaway vs eat-in rates, export, exemptions (spec §2.C). */
class FiscalPosition extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'fiscal_positions';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'auto_apply' => 'boolean',
            'vat_required' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<FiscalPositionTax, $this> */
    public function taxMappings(): HasMany
    {
        return $this->hasMany(FiscalPositionTax::class);
    }

    /** @return BelongsTo<Country, $this> */
    public function country(): BelongsTo
    {
        return $this->belongsTo(Country::class);
    }

    /** @return BelongsTo<CountryState, $this> */
    public function state(): BelongsTo
    {
        return $this->belongsTo(CountryState::class, 'state_id');
    }

    /**
     * Map a source tax to its destination(s). An empty result means the tax is
     * removed (exemption); no mapping row at all means it passes through.
     *
     * @return list<int|null>
     */
    public function mapTax(int $taxId): array
    {
        $rows = $this->taxMappings->where('tax_src_id', $taxId);

        if ($rows->isEmpty()) {
            return [$taxId];
        }

        return $rows->pluck('tax_dest_id')->filter()->values()->all();
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where(fn (Builder $q) => $q
                ->whereKey($config->default_fiscal_position_id)
                ->orWhereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey())));
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_fiscal_position');
    }
}
