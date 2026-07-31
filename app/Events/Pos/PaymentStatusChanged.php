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
 * Terminal / online payment state machine (spec 03 §5.4, `payment.status`).
 *
 * Latency-critical: it drives the payment screen and the customer's phone, so
 * it is queued on the dedicated `realtime` connection rather than the default.
 */
final class PaymentStatusChanged implements ShouldBroadcast
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /** @param array<string, mixed>|null $terminal */
    public function __construct(
        public string $configToken,
        public string $orderUuid,
        public string $paymentUuid,
        public string $status,
        public string $amount,
        public ?string $orderAccessToken = null,
        public ?array $terminal = null,
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
        return 'payment.status';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'order_uuid' => $this->orderUuid,
            'payment_uuid' => $this->paymentUuid,
            'status' => $this->status,
            'amount' => $this->amount,
            'terminal' => $this->terminal,
        ];
    }
}
