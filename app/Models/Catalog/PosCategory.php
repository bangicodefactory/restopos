<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\MediaFile;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPrinter;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * The register's browsing tree, distinct from the accounting/product category
 * tree (spec §2.B). `path` is a materialised path of **ids, terminated** (`/1/7/22/`) replacing
 * Odoo's `parent_path`, so descendant queries are a single LIKE.
 *
 * Both halves of that shape are load-bearing, and neither used to hold (BAN-422). Ids, so a rename
 * does not have to rewrite the subtree. Terminated, so a prefix cannot collide: `/Drink` matched
 * `/Drinks special` and swept an unrelated sibling into the subtree, while `/1/` cannot prefix
 * `/11/`. `CategoryTree` is the only thing that writes it.
 */
class PosCategory extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;

    protected $table = 'pos_categories';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'depth' => 'integer',
            'sequence' => 'integer',
            'color' => 'integer',
            'hour_after' => 'decimal:2',
            'hour_until' => 'decimal:2',
            'self_order_visible' => 'boolean',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<PosCategory, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    /** @return HasMany<PosCategory, $this> */
    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id')->orderBy('sequence');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function image(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'image_media_id');
    }

    /** @return BelongsToMany<Product, $this> */
    public function products(): BelongsToMany
    {
        return $this->belongsToMany(Product::class, 'pos_category_product')
            ->withPivot('sequence');
    }

    /** @return BelongsToMany<PosPrinter, $this> */
    public function printers(): BelongsToMany
    {
        return $this->belongsToMany(PosPrinter::class, 'pos_category_pos_printer');
    }

    /** @return BelongsToMany<PrepDisplay, $this> */
    public function prepDisplays(): BelongsToMany
    {
        return $this->belongsToMany(PrepDisplay::class, 'pos_category_prep_display');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_pos_category');
    }

    /** The category and every descendant (materialised path). @param Builder<static> $query */
    public function scopeSubtreeOf(Builder $query, self $category): Builder
    {
        return $query->where(fn (Builder $q) => $q
            ->whereKey($category->getKey())
            ->orWhere('path', 'like', $category->path.'%'));
    }

    /** @param  Builder<static>  $query */
    public function scopeVisibleInSelfOrder(Builder $query): Builder
    {
        return $query->where('self_order_visible', true)->where('active', true);
    }

    /** Availability window (0–24 float); NULL bounds mean "always". */
    public function isAvailableAt(float $hourOfDay): bool
    {
        if ($this->hour_after === null && $this->hour_until === null) {
            return true;
        }

        $from = (float) ($this->hour_after ?? 0);
        $to = (float) ($this->hour_until ?? 24);

        return $hourOfDay >= $from && $hourOfDay <= $to;
    }

    /**
     * When the config limits categories, the allowed ones plus every descendant
     * plus the categories routed to its printers/displays (spec §5.3).
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $query = static::query()->where('company_id', $config->company_id);

        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            $query->where('self_order_visible', true);
        }

        if (! $config->limit_categories) {
            return $query->orderBy('sequence');
        }

        $allowed = $config->limitedCategories()->get();

        return $query->where(function (Builder $q) use ($allowed): void {
            $q->whereIn('id', $allowed->modelKeys());

            foreach ($allowed as $category) {
                $q->orWhere('path', 'like', $category->path.'%');
            }
        })->orderBy('sequence');
    }
}
