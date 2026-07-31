<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Enums\OrderState;
use App\Models\Pos\Order;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * The full order graph: order + lines + payments + courses (spec 01-schema §5.4).
 *
 * Every monetary field is a **string** on the wire. A JSON number goes through
 * an IEEE-754 double on both ends; `"48.30"` does not (docs/CONVENTIONS.md).
 *
 * @mixin Order
 */
final class OrderResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var Order $order */
        $order = $this->resource;

        return [
            'id' => (int) $order->getKey(),
            'uuid' => (string) $order->uuid,
            'name' => $order->name,
            'sequence_number' => $order->sequence_number,
            'receipt_number' => $order->receipt_number,
            'tracking_number' => $order->tracking_number,
            'ticket_code' => $order->ticket_code,
            'access_token' => (string) $order->access_token,
            'source' => (string) ($order->source?->value ?? $order->source),
            'state' => $order->state instanceof OrderState ? $order->state->value : (string) $order->state,
            'prep_state' => (string) ($order->prep_state?->value ?? $order->prep_state),
            'pos_session_id' => (int) $order->pos_session_id,
            'pos_config_id' => (int) $order->pos_config_id,
            'pos_device_id' => $order->pos_device_id,
            'customer_id' => $order->customer_id,
            'employee_id' => $order->employee_id,
            'pricelist_id' => $order->pricelist_id,
            'fiscal_position_id' => $order->fiscal_position_id,
            'pos_preset_id' => $order->pos_preset_id,
            'preset_time' => $order->preset_time,
            'restaurant_table_id' => $order->restaurant_table_id,
            'guest_count' => (int) $order->guest_count,
            'floating_order_name' => $order->floating_order_name,
            'is_refund' => (bool) $order->is_refund,
            'refunded_order_id' => $order->refunded_order_id,
            'to_invoice' => (bool) $order->to_invoice,
            'general_customer_note' => $order->general_customer_note,
            'internal_note' => $order->internal_note,
            'amount_untaxed' => (string) $order->amount_untaxed,
            'amount_tax' => (string) $order->amount_tax,
            'amount_total' => (string) $order->amount_total,
            'amount_rounding' => (string) $order->amount_rounding,
            'amount_paid' => (string) $order->amount_paid,
            'amount_change' => (string) $order->amount_change,
            'amount_due' => (string) $order->amount_due,
            'amount_discount' => (string) $order->amount_discount,
            'tax_details' => $order->tax_details,
            'ordered_at' => $order->ordered_at,
            'paid_at' => $order->paid_at,
            'synced_at' => $order->synced_at,
            'updated_at' => $order->updated_at,
            'lines' => OrderLineResource::collection($this->whenLoaded('lines')),
            'payments' => OrderPaymentResource::collection($this->whenLoaded('payments')),
            'courses' => OrderCourseResource::collection($this->whenLoaded('courses')),
        ];
    }
}
