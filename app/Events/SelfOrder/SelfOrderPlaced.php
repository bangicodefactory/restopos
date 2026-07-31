<?php

declare(strict_types=1);

namespace App\Events\SelfOrder;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A customer submitted a cart from the QR menu or the kiosk (spec 03 §5.4,
 * `selforder.order.state`).
 *
 * Goes to the registers of the config (so the floor plan and ticket list light
 * up) and to the customer's own public order channel.
 */
final class SelfOrderPlaced implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    public function __construct(
        public string $configToken,
        public string $orderUuid,
        public ?int $orderId,
        public string $orderAccessToken,
        public string $state,
        public ?int $tableId,
        public ?string $trackingNumber,
        public string $amountTotal,
        public string $source,
        public bool $appended = false,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('pos.config.'.$this->configToken),
            new Channel('pos.order.'.$this->orderAccessToken),
        ];
    }

    public function broadcastAs(): string
    {
        return 'selforder.placed';
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
            'tracking_number' => $this->trackingNumber,
            'amount_total' => $this->amountTotal,
            'source' => $this->source,
            'appended' => $this->appended,
        ];
    }
}
