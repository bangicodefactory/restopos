<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\Pos\PosDevice;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Device liveness, off the hot path (spec 03 §2.2).
 *
 * A `last_seen_at` write on every sync request would put a row update in front
 * of every single order push; queued, it costs the request nothing.
 */
final class TouchDeviceSeen implements ShouldQueue
{
    use Queueable;

    public function __construct(
        private readonly int $deviceId,
        private readonly ?string $userAgent = null,
    ) {}

    public function handle(): void
    {
        PosDevice::query()->whereKey($this->deviceId)->update(array_filter([
            'last_seen_at' => now(),
            'user_agent' => $this->userAgent,
        ]));
    }

    public function uniqueId(): string
    {
        return 'device-seen:'.$this->deviceId;
    }
}
