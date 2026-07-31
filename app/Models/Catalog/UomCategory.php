<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Minimal unit-of-measure category (spec §2.B). */
class UomCategory extends Model
{
    protected $table = 'uom_categories';

    protected $guarded = [];

    /** @return HasMany<Uom, $this> */
    public function uoms(): HasMany
    {
        return $this->hasMany(Uom::class);
    }
}
