<?php

declare(strict_types=1);

namespace App\Models\SelfOrder;

use App\Enums\SelfOrderLinkStyle;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/**
 * A configurable button on the self-order landing page — "Book a table",
 * "Our story", "Allergens" (spec §2.I).
 *
 * An **empty** `pos_config_self_order_custom_link` pivot means "show this link
 * on every config", which is Odoo's semantics and is what `posLoadScope()`
 * below implements.
 */
class CustomLink extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'self_order_custom_links';

    /** @var list<string> */
    protected $fillable = [
        'company_id',
        'name',
        'url',
        'style',
        'open_in_new_tab',
        'sequence',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'style' => SelfOrderLinkStyle::class,
            'open_in_new_tab' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(
            PosConfig::class,
            'pos_config_self_order_custom_link',
            'self_order_custom_link_id',
            'pos_config_id',
        );
    }

    /** Global links (no pivot row at all) plus the ones bound to this config. */
    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        $id = $config instanceof PosConfig ? $config->getKey() : $config;

        return $query->where(fn (Builder $q) => $q
            ->whereDoesntHave('posConfigs')
            ->orWhereHas('posConfigs', fn (Builder $c) => $c->whereKey($id)));
    }

    /** @param  Builder<static>  $query */
    public function scopeOrdered(Builder $query): Builder
    {
        return $query->orderBy('sequence')->orderBy('id');
    }

    /** Bootstrap scoping (spec §5.3): via the pivot, empty pivot ⇒ all. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->active()
            ->forConfig($config)
            ->ordered();
    }
}
