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
 * An order was accepted by `POST /api/pos/sync` (spec 03 §5.4, `order.changed`).
 *
 * Deliberately **thin**: an id, a state and enough context for a peer register
 * to decide whether it cares. A fat event is a second, unversioned, untested
 * serialisation path; a thin event is a cache-invalidation hint.
 */
final class OrderSynced implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    public function __construct(
        public string $configToken,
        public string $orderUuid,
        public ?int $orderId,
        public string $state,
        public ?int $tableId,
        public string $amountTotal,
        public string $updatedAt,
        public ?string $emittedByDeviceUuid = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new PrivateChannel('pos.config.'.$this->configToken)];
    }

    public function broadcastAs(): string
    {
        return 'order.synced';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'order_uuid' => $this->orderUuid,
            'order_id' => $this->orderId,
            'state' => $this->state,
            'table_id' => $this->tableId,
            'amount_total' => $this->amountTotal,
            'updated_at' => $this->updatedAt,
            'emitted_by_device_uuid' => $this->emittedByDeviceUuid,
        ];
    }
}
