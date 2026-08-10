<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Enums\SessionEventType;
use App\Models\Pos\PosSession;
use App\Models\Pos\SessionEvent;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Write the shift's story, one row per transition (REG-024).
 *
 * A separate class rather than a method on {@see SessionService} because the guarantee is a
 * property of the writing, not of any one caller: **exactly one row per lifecycle transition.**
 * `close()` runs inside a transaction that can be retried, an order push can reroute into a rescue
 * session more than once, and the register re-sends. Idempotency therefore lives here, keyed on the
 * session and the event type, so a caller cannot get it wrong by being called twice.
 *
 * The exception is {@see SessionEventType::XReport} and the cash movements, which are genuine
 * repeatable actions: pulling two readings is two readings, and two cash-outs are two cash-outs.
 * Those are appended every time, which is why the key is per-type rather than blanket.
 */
final readonly class SessionEventRecorder
{
    /**
     * @param  array<string, mixed>  $payload
     */
    public function record(
        PosSession $session,
        SessionEventType $type,
        array $payload = [],
        ?int $employeeId = null,
        ?int $userId = null,
        ?int $deviceId = null,
    ): ?SessionEvent {
        // A transition happens once; an action can happen all shift. Recording the first kind twice
        // turns "the float was confirmed" into a till that was opened repeatedly, which is exactly
        // the sort of thing somebody would later have to explain.
        if (! $this->repeatable($type) && $this->alreadyRecorded($session, $type)) {
            return null;
        }

        /** @var SessionEvent $event */
        $event = SessionEvent::query()->create([
            'uuid' => (string) Str::uuid(),
            'pos_session_id' => (int) $session->getKey(),
            'company_id' => (int) $session->company_id,
            'event_type' => $type->value,
            'payload' => $payload === [] ? null : $payload,
            'employee_id' => $employeeId,
            'user_id' => $userId,
            'pos_device_id' => $deviceId,
            'occurred_at' => Carbon::now(),
        ]);

        return $event;
    }

    /** Actions a shift can genuinely repeat, as opposed to states it passes through once. */
    private function repeatable(SessionEventType $type): bool
    {
        return in_array($type, [
            SessionEventType::XReport,
            SessionEventType::CashIn,
            SessionEventType::CashOut,
        ], true);
    }

    private function alreadyRecorded(PosSession $session, SessionEventType $type): bool
    {
        return SessionEvent::query()
            ->where('pos_session_id', $session->getKey())
            ->where('event_type', $type->value)
            ->exists();
    }
}
