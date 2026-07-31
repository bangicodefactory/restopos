<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PrinterType;
use App\Models\Catalog\PosCategory;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Kitchen\PrintJob;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Preparation (kitchen/bar) or receipt printer with category routing (spec §2.D). */
class PosPrinter extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pos_printers';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'printer_type' => PrinterType::class,
            'printer_port' => 'integer',
            'is_receipt_printer' => 'boolean',
            'print_all_categories' => 'boolean',
            'characters_per_line' => 'integer',
            'copies' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsToMany<PosCategory, $this> */
    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'pos_category_pos_printer');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_printer');
    }

    /** @return HasMany<PrintJob, $this> */
    public function jobs(): HasMany
    {
        return $this->hasMany(PrintJob::class);
    }

    /** Routing: everything, or only the frozen categories of the line. */
    public function handlesCategory(?int $posCategoryId): bool
    {
        if ($this->print_all_categories) {
            return true;
        }

        return $posCategoryId !== null && $this->categories->contains('id', $posCategoryId);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($config->getKey()));
    }
}
