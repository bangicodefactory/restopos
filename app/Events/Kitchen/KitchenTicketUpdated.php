<?php

declare(strict_types=1);

namespace App\Events\Kitchen;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * Stage / line-state movement on an existing ticket, including recall
 * (spec 03 §5.4, `prep.line.state`).
 */
final class KitchenTicketUpdated implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /** @param list<array<string, mixed>> $lines */
    public function __construct(
        public string $displayToken,
        public string $configToken,
        public int $prepOrderId,
        public string $prepOrderUuid,
        public string $state,
        public array $lines = [],
        public bool $recalled = false,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('kitchen.display.'.$this->displayToken),
            new PrivateChannel('pos.config.'.$this->configToken),
        ];
    }

    public function broadcastAs(): string
    {
        return 'kitchen.ticket.updated';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'prep_order_id' => $this->prepOrderId,
            'prep_order_uuid' => $this->prepOrderUuid,
            'state' => $this->state,
            'lines' => $this->lines,
            'recalled' => $this->recalled,
        ];
    }
}
