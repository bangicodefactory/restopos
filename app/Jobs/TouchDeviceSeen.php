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
        private readonly ?string $appVersion = null,
        private readonly bool $synced = false,
    ) {}

    public function handle(): void
    {
        // `array_filter` drops the nulls, so a request that reports no version leaves the recorded
        // one alone rather than blanking what the last one said.
        $touch = array_filter([
            'last_seen_at' => now(),
            'user_agent' => $this->userAgent,
            // BAN-456. The version captured at pairing is the build installed that day; this is the
            // one actually running, which is the number the back office needs in order to say a
            // till is behind.
            'app_version' => $this->appVersion,
        ]);

        if ($this->synced) {
            // `last_synced_at` has been on the table and rendered on the devices page since both
            // were written, and nothing ever wrote it — so "last synced" was blank on every device,
            // forever.
            $touch['last_synced_at'] = now();
        }

        PosDevice::query()->whereKey($this->deviceId)->update($touch);
    }

    public function uniqueId(): string
    {
        return 'device-seen:'.$this->deviceId;
    }
}
