<?php

declare(strict_types=1);

namespace App\Listeners;

use App\Jobs\BroadcastCatalogChange;
use App\Models\Pos\PosConfig;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\Eloquent\Model;

/**
 * Turns a catalog write into a coalesced `catalog.changed` broadcast
 * (spec 03 §5.4).
 *
 * Wired in `PosServiceProvider` to Eloquent's `saved`/`deleted` events for the
 * client-visible catalog models rather than to an observer, so `app/Models`
 * stays free of sync concerns — models hold relations, casts and scopes only
 * (docs/CONVENTIONS.md § Layering).
 *
 * The actual fan-out is queued and debounced: a bulk price import touching forty
 * thousand rows must produce one event per register, not forty thousand.
 */
final class InvalidateCatalogCache implements ShouldQueue
{
    /** Payload key of the model that changed, resolved from its table name. */
    private const MODEL_KEYS = [
        'products' => 'products',
        'product_variants' => 'product_variants',
        'pricelist_items' => 'pricelist_items',
        'pricelists' => 'pricelists',
        'taxes' => 'taxes',
        'pos_categories' => 'pos_categories',
        'payment_methods' => 'payment_methods',
    ];

    public function handle(Model $model): void
    {
        $key = self::MODEL_KEYS[$model->getTable()] ?? null;

        if ($key === null) {
            return;
        }

        $companyId = $model->getAttribute('company_id');

        $configIds = PosConfig::query()
            ->where('active', true)
            ->when($companyId !== null, fn ($q) => $q->where('company_id', $companyId))
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        if ($configIds === []) {
            return;
        }

        BroadcastCatalogChange::dispatch(
            configIds: $configIds,
            models: [$key],
            productIds: $key === 'products' ? [(int) $model->getKey()] : [],
        );
    }
}
