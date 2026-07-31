<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\NoteScope;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** Predefined quick note chip ("no onions", "well done") — spec §2.D. */
class PosNote extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pos_notes';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'color' => 'integer',
            'note_scope' => NoteScope::class,
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_note');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($config->getKey()))
            ->orderBy('sequence');
    }
}
