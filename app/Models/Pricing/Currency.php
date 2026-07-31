<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Enums\SymbolPosition;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** ISO-4217 currency (spec §2.C). Money is rounded to `decimal_places` at persistence boundaries. */
class Currency extends Model implements PosLoadable
{
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'currencies';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'symbol_position' => SymbolPosition::class,
            'decimal_places' => 'integer',
            'rounding' => 'decimal:6',
            'iso_numeric' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return HasMany<CurrencyRate, $this> */
    public function rates(): HasMany
    {
        return $this->hasMany(CurrencyRate::class);
    }

    /** @return HasMany<Pricelist, $this> */
    public function pricelists(): HasMany
    {
        return $this->hasMany(Pricelist::class);
    }

    public function format(string|float $amount): string
    {
        $value = number_format((float) $amount, $this->decimal_places, '.', ' ');

        return $this->symbol_position === SymbolPosition::Before
            ? $this->symbol.$value
            : $value.' '.$this->symbol;
    }

    /** Round to the currency's smallest representable increment. */
    public function round(string|float $amount): string
    {
        return number_format((float) $amount, $this->decimal_places, '.', '');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $key = (new static)->getQualifiedKeyName();
        $companyCurrencyId = $config->company?->currency_id;

        return static::query()->where(function (Builder $q) use ($config, $profile, $key, $companyCurrencyId): void {
            $q->whereKey($config->currency_id);

            if ($companyCurrencyId !== null) {
                $q->orWhere($key, '=', $companyCurrencyId);
            }

            $q->orWhereIn('id', Pricelist::posLoadScope($config, $profile)->select('currency_id'));
        });
    }
}
