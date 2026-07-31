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
 * A lifecycle transition on an order — draft → paid → done → cancelled
 * (spec 03 §5.4). Broadcast on the config channel and, when the order carries a
 * customer access token, on that order's public capability channel so a phone
 * following its own order sees the change.
 */
final class OrderStateChanged implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    public function __construct(
        public string $configToken,
        public string $orderUuid,
        public ?int $orderId,
        public string $fromState,
        public string $toState,
        public ?string $orderAccessToken = null,
        public ?string $trackingNumber = null,
        public ?string $emittedByDeviceUuid = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        $channels = [new PrivateChannel('pos.config.'.$this->configToken)];

        if ($this->orderAccessToken !== null) {
            $channels[] = new Channel('pos.order.'.$this->orderAccessToken);
        }

        return $channels;
    }

    public function broadcastAs(): string
    {
        return 'order.state';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'order_uuid' => $this->orderUuid,
            'order_id' => $this->orderId,
            'from_state' => $this->fromState,
            'to_state' => $this->toState,
            'tracking_number' => $this->trackingNumber,
            'emitted_by_device_uuid' => $this->emittedByDeviceUuid,
        ];
    }
}
