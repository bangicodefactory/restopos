<?php

declare(strict_types=1);

namespace App\Events\Pos;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * Catalog invalidation hint (spec 03 §5.4, `catalog.changed` +
 * `product.availability`).
 *
 * Emitted from a queued listener with a coalescing window so a bulk price
 * import produces one event, not forty thousand.
 */
final class ProductChanged implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /**
     * @param  list<string>  $models
     * @param  list<int>  $productIds
     */
    public function __construct(
        public string $configToken,
        public array $models = ['products'],
        public array $productIds = [],
        public ?bool $available = null,
        public ?string $since = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('pos.config.'.$this->configToken),
            new Channel('pos.self.'.$this->configToken),
        ];
    }

    public function broadcastAs(): string
    {
        return 'catalog.changed';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'models' => $this->models,
            'product_ids' => $this->productIds,
            'available' => $this->available,
            'since' => $this->since,
        ];
    }
}
