<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Events\Pos\ProductChanged;
use App\Models\Pos\PosConfig;
use Illuminate\Contracts\Cache\Repository as Cache;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Coalesced catalog invalidation (spec 03 §5.4, "debouncing at the source").
 *
 * A bulk price import touches forty thousand rows; forty thousand websocket
 * frames would be worse than useless. A cache lock collapses everything inside
 * the window into one event per config.
 */
final class BroadcastCatalogChange implements ShouldQueue
{
    use Queueable;

    /**
     * @param  list<int>  $configIds
     * @param  list<string>  $models
     * @param  list<int>  $productIds
     */
    public function __construct(
        private readonly array $configIds,
        private readonly array $models = ['products'],
        private readonly array $productIds = [],
        private readonly int $windowSeconds = 2,
    ) {}

    public function handle(Cache $cache, Dispatcher $events): void
    {
        foreach ($this->configIds as $configId) {
            $key = 'pos:catalog-changed:'.$configId.':'.md5(implode(',', $this->models));

            if ($cache->get($key) !== null) {
                continue;
            }

            $cache->put($key, true, $this->windowSeconds);

            $config = PosConfig::query()->find($configId);

            if ($config === null) {
                continue;
            }

            $events->dispatch(new ProductChanged(
                configToken: (string) $config->access_token,
                models: $this->models,
                productIds: $this->productIds,
                since: now()->subSeconds($this->windowSeconds)->toIso8601ZuluString('microsecond'),
            ));
        }
    }
}
