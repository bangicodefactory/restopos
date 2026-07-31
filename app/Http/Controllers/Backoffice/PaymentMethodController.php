<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PaymentProvider;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `PaymentMethods/Index` (spec 02 BOF-110…BOF-119).
 *
 * `is_cash_count` is the flag that decides whether a method lands in the
 * drawer-count at session close; getting it wrong silently breaks every cash
 * reconciliation, so it is surfaced as its own column.
 */
final class PaymentMethodController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('PaymentMethods/Index', [
            'methods' => PaymentMethod::query()->orderBy('sequence')->get()->map(static fn (PaymentMethod $m): array => [
                'id' => (int) $m->getKey(),
                'name' => (string) $m->name,
                'method_type' => (string) ($m->method_type?->value ?? $m->method_type),
                'is_cash_count' => (bool) $m->is_cash_count,
                'currency_id' => (int) $m->currency_id,
                'identify_customer' => (bool) $m->identify_customer,
                'allow_change' => (bool) $m->allow_change,
                'allow_refund' => (bool) $m->allow_refund,
                'is_rounding_target' => (bool) $m->is_rounding_target,
                'terminal_provider' => (string) ($m->terminal_provider?->value ?? $m->terminal_provider),
                'payment_provider_id' => $m->payment_provider_id,
                'ledger_code' => $m->ledger_code,
                'sequence' => (int) $m->sequence,
                'active' => (bool) $m->active,
            ])->values()->all(),
            'providers' => PaymentProvider::query()->get(['id', 'name', 'code', 'state'])->all(),
        ]);
    }

    public function update(Request $request, PaymentMethod $paymentMethod): RedirectResponse
    {
        $paymentMethod->forceFill($request->validate([
            'name' => ['sometimes', 'string', 'max:64'],
            'is_cash_count' => ['sometimes', 'boolean'],
            'identify_customer' => ['sometimes', 'boolean'],
            'allow_change' => ['sometimes', 'boolean'],
            'allow_refund' => ['sometimes', 'boolean'],
            'is_rounding_target' => ['sometimes', 'boolean'],
            'ledger_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]))->save();

        return back()->with('success', 'Payment method saved.');
    }
}
