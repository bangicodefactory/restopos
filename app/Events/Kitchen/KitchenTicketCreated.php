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
 * A new preparation ticket reached a display (spec 03 §5.4, `prep.ticket`).
 *
 * This is the one **fat** event in the catalogue, by design: a kitchen ticket
 * must appear instantly and the KDS is a display, not a source of truth, so we
 * do not make it round-trip for the body.
 */
final class KitchenTicketCreated implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /** @param array<string, mixed> $ticket */
    public function __construct(
        public string $displayToken,
        public string $configToken,
        public array $ticket,
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
        return 'kitchen.ticket.created';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return ['v' => $this->v, 'ticket' => $this->ticket];
    }
}
