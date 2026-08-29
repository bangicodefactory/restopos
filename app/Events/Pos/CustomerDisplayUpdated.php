<?php

declare(strict_types=1);

namespace App\Events\Pos;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * What the screen facing the customer should be showing right now (REG-352, XCT-031).
 *
 * ── This event deliberately breaks the project's realtime rule. Read this before "fixing" it. ──
 *
 * Every other event in `app/Events/` is a cache-invalidation hint: an id, a state, and enough
 * context for the receiver to decide whether to call `delta.pull()`. `use-echo.ts` states the rule
 * at the top of the file — *realtime is never the transport for order data* — and it is what lets a
 * till keep trading when the socket is down.
 *
 * The customer display is the one surface where that rule cannot hold, and the reason is structural
 * rather than expedient:
 *
 *   * **It has no local replica to pull from.** The register, the KDS and the kiosk all hold an
 *     IndexedDB copy of the rows an event refers to, so a hint is enough. The display holds
 *     nothing — it is a propless, tokenless render target that a stranger can see, and giving it a
 *     replica would mean giving it a device identity, a boot phase and a copy of the venue's
 *     catalogue on a screen pointed at the public.
 *   * **It has nothing to pull *with*.** `delta` sits behind `device.can:pos:catalog`; the display
 *     holds no bearer token, so a hint would name rows it has no way to fetch.
 *   * **Nothing is lost when it fails.** A dropped hint elsewhere means a stale replica and a
 *     wrong number in front of a cashier. A dropped frame here means the customer's screen lags
 *     until the next keystroke, and the register — the system of record — never depended on it.
 *
 * So the payload travels whole. It is a *projection* of the order that the register already
 * computed for the same screen on `BroadcastChannel`, never a source of truth: nothing reads it
 * back, nothing persists it, and the register does not wait for it.
 *
 * ── The channel ──
 *
 * Public, and named by `PosConfig::customerDisplayToken()`. The channel name *is* the capability,
 * the same property `pos.order.{orderToken}` relies on — a display holds no credential and cannot
 * authenticate, so there is nothing else for an authorizer to check. That token is **not**
 * `access_token`: `access_token` is on every table's self-order QR, and a channel named by it would
 * let any guest in the room watch every sale. See the derivation's docblock on the model.
 */
final class CustomerDisplayUpdated implements ShouldBroadcastNow
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    /**
     * @param  array<string, mixed>  $payload  the display projection, rendered as-is
     */
    public function __construct(
        public string $displayToken,
        public array $payload,
        public ?string $emittedByDeviceUuid = null,
        public int $v = 1,
    ) {}

    /** @return list<Channel> */
    public function broadcastOn(): array
    {
        return [new Channel('pos.display.'.$this->displayToken)];
    }

    public function broadcastAs(): string
    {
        return 'display.update';
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'v' => $this->v,
            'payload' => $this->payload,
            'emitted_by_device_uuid' => $this->emittedByDeviceUuid,
        ];
    }
}
