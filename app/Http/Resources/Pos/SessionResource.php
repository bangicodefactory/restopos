<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Models\Pos\PosSession;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin PosSession */
final class SessionResource extends JsonResource
{
    public static $wrap = null;

    /** The raw column names {@see floats} replaces — stripped wherever a row is built from the model. */
    public const RenamedColumns = ['cash_balance_opening', 'cash_balance_opening_expected'];

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var PosSession $session */
        $session = $this->resource;

        return [
            'id' => (int) $session->getKey(),
            'uuid' => (string) $session->uuid,
            'pos_config_id' => (int) $session->pos_config_id,
            // Null until the opening control is confirmed — a session awaiting one has no number
            // yet, and inventing a blank string here would hide that from the client.
            'name' => $session->name === null ? null : (string) $session->name,
            'state' => (string) ($session->state?->value ?? $session->state),
            'opened_at' => $session->opened_at,
            'closed_at' => $session->closed_at,
            'business_date' => $session->business_date,
            'has_cash_control' => (bool) $session->has_cash_control,
            ...self::floats($session),
            'cash_balance_closing_counted' => $session->cash_balance_closing_counted === null ? null : (string) $session->cash_balance_closing_counted,
            'cash_balance_closing_expected' => (string) $session->cash_balance_closing_expected,
            'cash_difference' => (string) $session->cash_difference,
            'cash_in_total' => (string) $session->cash_in_total,
            'cash_out_total' => (string) $session->cash_out_total,
            'order_count' => (int) $session->order_count,
            'order_amount_total' => (string) $session->order_amount_total,
            'refund_amount_total' => (string) $session->refund_amount_total,
            'payments_total' => (string) $session->payments_total,
            'is_rescue' => (bool) $session->is_rescue,
            'closing_forced' => (bool) $session->closing_forced,
            'opened_by_employee_id' => $session->opened_by_employee_id,
            'closed_by_employee_id' => $session->closed_by_employee_id,
            'over_variance_approved_by_employee_id' => $session->over_variance_approved_by_employee_id,
        ];
    }

    /**
     * The opening amounts under the names the client reads (`packages/domain` PosSessionRow).
     *
     * The columns are `cash_balance_opening` and `cash_balance_opening_expected`; the client has
     * always called the first `opening_float`. Shared with `BootstrapService::sessionPayload`
     * because a session reaches the register down **two** paths — bootstrap and this endpoint — and
     * a rename applied to one of them is worse than no rename at all: the field is simply absent on
     * whichever path was missed, and the screen that reads it shows nothing.
     *
     * @return array{opening_float: string, expected_opening_float: string}
     */
    public static function floats(PosSession $session): array
    {
        return [
            'opening_float' => (string) $session->cash_balance_opening,
            // What the previous close counted into the drawer (REG-004).
            'expected_opening_float' => (string) $session->cash_balance_opening_expected,
        ];
    }
}
