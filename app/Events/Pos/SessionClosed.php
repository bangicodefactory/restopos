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
 * A session reached `closed` (spec 03 §5.4, `session.state`).
 *
 * Every register on the config must flush its outbox, refuse new orders and
 * reload; a till still ringing sales into a closed session is a reconciliation
 * nightmare.
 */
final class SessionClosed implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /** @param array<string, mixed> $totals */
    public function __construct(
        public string $configToken,
        public int $sessionId,
        public string $state,
        public string $cashDifference,
        public array $totals = [],
        public ?string $emittedByDeviceUuid = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('pos.config.'.$this->configToken),
            new PrivateChannel('pos.session.'.$this->sessionId),
        ];
    }

    public function broadcastAs(): string
    {
        return 'session.closed';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'session_id' => $this->sessionId,
            'state' => $this->state,
            'cash_difference' => $this->cashDifference,
            'totals' => $this->totals,
            'emitted_by_device_uuid' => $this->emittedByDeviceUuid,
        ];
    }
}
