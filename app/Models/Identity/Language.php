<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Models\Concerns\HasActiveState;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** UI language selectable in the register / self-order app (spec §2.A). */
class Language extends Model
{
    use HasActiveState;

    protected $table = 'languages';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'is_rtl' => 'boolean',
            'active' => 'boolean',
            'sequence' => 'integer',
        ];
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_language')
            ->withPivot('sequence');
    }
}
