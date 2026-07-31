<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Models\Pricing\Currency;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Global ISO-3166 lookup (spec §2.A). */
class Country extends Model
{
    protected $table = 'countries';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'phone_code' => 'integer',
            'requires_state' => 'boolean',
        ];
    }

    /** @return HasMany<CountryState, $this> */
    public function states(): HasMany
    {
        return $this->hasMany(CountryState::class);
    }

    /** @return BelongsTo<Currency, $this> */
    public function currency(): BelongsTo
    {
        return $this->belongsTo(Currency::class);
    }

    /** @return HasMany<Company, $this> */
    public function companies(): HasMany
    {
        return $this->hasMany(Company::class);
    }
}
