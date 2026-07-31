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

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var PosSession $session */
        $session = $this->resource;

        return [
            'id' => (int) $session->getKey(),
            'uuid' => (string) $session->uuid,
            'pos_config_id' => (int) $session->pos_config_id,
            'name' => (string) $session->name,
            'state' => (string) ($session->state?->value ?? $session->state),
            'opened_at' => $session->opened_at,
            'closed_at' => $session->closed_at,
            'business_date' => $session->business_date,
            'has_cash_control' => (bool) $session->has_cash_control,
            // The client reads `opening_float` (packages/domain PosSessionRow); the column is
            // `cash_balance_opening`. BootstrapService applies the same rename on the bootstrap path.
            'opening_float' => (string) $session->cash_balance_opening,
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
}
