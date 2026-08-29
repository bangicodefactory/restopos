<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Models\Pos\OrderLine;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin OrderLine */
final class OrderLineResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var OrderLine $line */
        $line = $this->resource;

        return [
            'id' => (int) $line->getKey(),
            'uuid' => (string) $line->uuid,
            'pos_order_id' => (int) $line->pos_order_id,
            'line_number' => $line->line_number,
            'product_variant_id' => (int) $line->product_variant_id,
            'product_id' => (int) $line->product_id,
            'pos_category_id' => $line->pos_category_id,
            'full_product_name' => (string) $line->full_product_name,
            'uom_id' => (int) $line->uom_id,
            'quantity' => (string) $line->quantity,
            'price_unit' => (string) $line->price_unit,
            'price_extra' => (string) $line->price_extra,
            'price_type' => (string) ($line->price_type?->value ?? $line->price_type),
            'discount_percent' => (string) $line->discount_percent,
            'discount_amount' => (string) $line->discount_amount,
            'price_subtotal' => (string) $line->price_subtotal,
            'price_subtotal_incl' => (string) $line->price_subtotal_incl,
            'tax_details' => $line->tax_details,
            'tax_signature' => (string) $line->tax_signature,
            'customer_note' => $line->customer_note,
            'internal_note' => $line->internal_note,
            'combo_parent_line_id' => $line->combo_parent_line_id,
            'combo_item_id' => $line->combo_item_id,
            'restaurant_course_id' => $line->restaurant_course_id,
            'refunded_order_line_id' => $line->refunded_order_line_id,
            'refunded_quantity' => (string) $line->refunded_quantity,
            'skip_preparation' => (bool) $line->skip_preparation,
            // XCT-058 — whether this weight was read or typed. Round-trips so a refund, a reprint
            // or another till sees the same provenance the selling till recorded.
            'weight_source' => $line->weight_source?->value,
            'discount_notice' => $line->discount_notice,
            'is_edited' => (bool) $line->is_edited,
            // The chosen variant attributes, which live in a pivot rather than on the row. A
            // ticket-screen refund copies these onto the refund line, so an order hydrated without
            // them would refund a "Large, oat milk" coffee at the plain price (REG-293, BAN-465).
            'attribute_line_value_ids' => $line->relationLoaded('attributeValues')
                ? $line->attributeValues->pluck('id')->map(static fn (mixed $id): int => (int) $id)->values()->all()
                : [],
        ];
    }
}
