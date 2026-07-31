<?php

declare(strict_types=1);

namespace App\Events\Restaurant;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * Floor-plan repaint hint: occupancy, guest count, running total, merge state
 * (spec 03 §5.4, `table.status` / `table.merged`).
 */
final class TableStateChanged implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /** @param list<int> $childTableIds */
    public function __construct(
        public string $configToken,
        public int $tableId,
        public bool $occupied,
        public int $orderCount,
        public int $guestCount,
        public string $amountTotal,
        public ?string $orderUuid = null,
        public array $childTableIds = [],
        public ?string $emittedByDeviceUuid = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('pos.config.'.$this->configToken),
            new PrivateChannel('pos.table.'.$this->tableId),
        ];
    }

    public function broadcastAs(): string
    {
        return 'table.state';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'table_id' => $this->tableId,
            'occupied' => $this->occupied,
            'order_count' => $this->orderCount,
            'guest_count' => $this->guestCount,
            'amount_total' => $this->amountTotal,
            'order_uuid' => $this->orderUuid,
            'child_table_ids' => $this->childTableIds,
            'emitted_by_device_uuid' => $this->emittedByDeviceUuid,
        ];
    }
}
