<?php

declare(strict_types=1);

namespace App\Models\Identity;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Sub-division of a country (spec §2.A). */
class CountryState extends Model
{
    protected $table = 'country_states';

    protected $guarded = [];

    /** @return BelongsTo<Country, $this> */
    public function country(): BelongsTo
    {
        return $this->belongsTo(Country::class);
    }
}
