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

    /**
     * Notes linked to the register, or global notes with no link at all (BAN-483).
     *
     * The fallback is the same one `PosBill` has always had and the same one the migration records
     * for `pos_config_bill`: no row means global. Without it this scope returned *only* linked notes
     * — and nothing anywhere could write a link, because the register settings page had no note
     * picker. So every register in existence received an empty note list, and the predefined-note
     * picker at the till was empty however many notes the venue had authored.
     *
     * The company filter is explicit rather than implied by the join, so the global branch is
     * scoped too: without it, an unlinked note would be global to every tenant.
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->where(fn (Builder $q) => $q
                ->whereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey()))
                ->orWhereDoesntHave('posConfigs'))
            ->orderBy('sequence');
    }
}
