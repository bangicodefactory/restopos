<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\OrderState;
use App\Models\Pos\Order;
use App\Models\Pos\PosPreset;
use Illuminate\Support\Carbon;

/**
 * Whether a service mode can take a booking at a given moment (BOF-113, BAN-429).
 *
 * `pos_presets.use_timing`, `slots_per_interval` and `interval_minutes` have been columns since the
 * schema was written, `preset_service_windows` ships to the client in the bootstrap payload, and
 * **nothing has ever read either of them**. `orders.preset_time` is written from whatever the client
 * sends. So a delivery preset advertising five orders per twenty minutes, open 11:00–14:00, accepted
 * a booking for 3 a.m. on a day the venue is closed, and accepted the fiftieth booking into the same
 * twenty minutes as readily as the first.
 *
 * The failure is not visible anywhere: the order looks ordinary, and the kitchen finds out when the
 * tickets arrive together.
 *
 * ## What "full" means
 *
 * Capacity is counted per interval, not per window. A booking at 12:05 with a twenty-minute interval
 * falls in the 12:00–12:20 bucket, and it is that bucket which holds `slots_per_interval` orders.
 * Buckets are anchored to midnight so the same instant always lands in the same one regardless of
 * when the window opens — otherwise moving a window's start time would silently re-bucket every
 * booking already taken.
 *
 * Cancelled orders do not hold a slot. A slot held by an order nobody will collect is a table left
 * empty on a full night.
 */
final class PresetSlotService
{
    /**
     * The reason this moment cannot be booked, or null if it can.
     *
     * A string rather than an exception because the two callers want different things from it: the
     * self-order surface shows it to the guest so they can pick another time, and the register sync
     * path logs it.
     */
    public function refusalFor(PosPreset $preset, ?string $when): ?string
    {
        if ($when === null || $preset->use_timing !== true) {
            return null;
        }

        $moment = Carbon::parse($when);

        if (! $this->isOpenAt($preset, $moment)) {
            return 'This mode is not open at that time.';
        }

        if ($this->isFullAt($preset, $moment)) {
            return 'That slot is fully booked. Choose another time.';
        }

        return null;
    }

    /** Does any window of this preset cover this instant? */
    public function isOpenAt(PosPreset $preset, Carbon $moment): bool
    {
        // No window *anywhere* means no hours were ever set, which is how every preset starts. A
        // preset with timing switched on and no hours yet should not silently refuse every booking:
        // the hours are the constraint and there are none. But once *any* day has hours, a day
        // without them is a day the venue is closed — asking only about this day would read Tuesday
        // as unconstrained on a Monday-only delivery service.
        if ($preset->serviceWindows()->doesntExist()) {
            return true;
        }

        $windows = $preset->serviceWindows()
            // 0 = Monday … 6 = Sunday. `dayOfWeek` is 0 = Sunday, which is the off-by-one this
            // column's comment exists to prevent.
            ->where('day_of_week', ($moment->dayOfWeek + 6) % 7)
            ->get();

        $hour = $moment->hour + $moment->minute / 60;

        foreach ($windows as $window) {
            if ($hour >= (float) $window->hour_from && $hour < (float) $window->hour_to) {
                return true;
            }
        }

        return false;
    }

    /** Has the interval containing this instant already taken its allowance? */
    public function isFullAt(PosPreset $preset, Carbon $moment): bool
    {
        $interval = max(1, (int) $preset->interval_minutes);
        $capacity = (int) $preset->slots_per_interval;

        if ($capacity < 1) {
            return true;
        }

        [$start, $end] = $this->bucketAround($moment, $interval);

        $taken = Order::query()
            ->where('pos_preset_id', $preset->getKey())
            ->where('state', '!=', OrderState::Cancelled->value)
            ->whereBetween('preset_time', [$start, $end])
            ->count();

        return $taken >= $capacity;
    }

    /**
     * The interval containing this instant, anchored to midnight.
     *
     * @return array{Carbon, Carbon}
     */
    private function bucketAround(Carbon $moment, int $intervalMinutes): array
    {
        $minutesIntoDay = $moment->hour * 60 + $moment->minute;
        $bucketStart = intdiv($minutesIntoDay, $intervalMinutes) * $intervalMinutes;

        $start = $moment->copy()->startOfDay()->addMinutes($bucketStart);

        // Exclusive of the next bucket's first second: `whereBetween` is inclusive at both ends, so
        // without this an order at exactly 12:20 would count against both 12:00–12:20 and
        // 12:20–12:40 and halve the effective capacity at every boundary.
        return [$start, $start->copy()->addMinutes($intervalMinutes)->subSecond()];
    }
}
