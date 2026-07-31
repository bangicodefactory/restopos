<?php

declare(strict_types=1);

namespace App\Http\Requests\Pos;

use App\Enums\OrderState;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * `POST /api/pos/sync` (spec 03 §3.6.1).
 *
 * Validation here is deliberately **shallow**: it rejects a malformed envelope,
 * not a business-invalid order. A single bad order must produce a per-record
 * `rejected` result, not a 422 that bounces the whole batch and blocks the queue
 * behind it.
 */
final class SyncOrdersRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'client_version' => ['nullable', 'string', 'max:32'],
            'client_time' => ['nullable', 'date'],
            'employee_id' => ['nullable', 'integer'],
            'orders' => ['required', 'array', 'min:1', 'max:'.config('pos.sync.max_orders_per_batch', 200)],
            'orders.*.uuid' => ['required', 'string', 'size:36'],
            'orders.*.op' => ['nullable', Rule::in(['upsert', 'cancel', 'delete_draft'])],
            'orders.*.base_rev' => ['nullable', 'string', 'max:64'],
            'orders.*.order' => ['nullable', 'array'],
            'orders.*.order.state' => ['nullable', Rule::enum(OrderState::class)],
            'orders.*.order.session_id' => ['nullable', 'integer'],
            // Monetary values are decimal strings on the wire, never JSON numbers.
            'orders.*.order.amount_total_client' => ['nullable', 'string'],
            'orders.*.order.amount_tax_client' => ['nullable', 'string'],
            'orders.*.lines' => ['nullable', 'array'],
            'orders.*.lines.*.uuid' => ['required_with:orders.*.lines', 'string', 'size:36'],
            'orders.*.lines.*.op' => ['nullable', Rule::in(['create', 'update', 'delete'])],
            'orders.*.payments' => ['nullable', 'array'],
            'orders.*.payments.*.uuid' => ['required_with:orders.*.payments', 'string', 'size:36'],
            'orders.*.payments.*.op' => ['nullable', Rule::in(['create', 'update', 'delete'])],
            'orders.*.courses' => ['nullable', 'array'],
            'orders.*.courses.*.uuid' => ['required_with:orders.*.courses', 'string', 'size:36'],
            'orders.*.courses.*.op' => ['nullable', Rule::in(['create', 'update', 'delete'])],
        ];
    }
}
