<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Pos\SettleAccountRequest;
use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosSession;
use App\Services\Pos\CustomerAccountLedger;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use InvalidArgumentException;

/**
 * A customer's running tab, read and settled from the register (REG-208, BOF-119).
 *
 * Online-only, deliberately. Everything else the register does is queued through the outbox and
 * survives a dead network, but a tab is shared state: two tills settling the same regular offline
 * would each compute a `balance_after` from a balance the other had already moved, and the ledger's
 * whole point is that the arithmetic is done once, under a lock, by the server. A cashier without a
 * network can still *charge* to the account — that goes through `sync` like any other payment —
 * they just cannot take money off it.
 */
final class CustomerAccountController extends Controller
{
    use ResolvesDeviceContext;

    /** How many movements a statement returns. Enough for a printed statement, not a data dump. */
    private const StatementLimit = 50;

    public function __construct(private readonly CustomerAccountLedger $ledger) {}

    /** `GET /api/pos/customers/{customer}/account` — balance plus recent movements. */
    public function show(Request $request, Customer $customer): JsonResponse
    {
        $this->assertOwned($request, $customer);

        return new JsonResponse($this->statement($customer));
    }

    /** `POST /api/pos/customers/{customer}/account/settle` — take money against the tab. */
    public function settle(SettleAccountRequest $request, Customer $customer): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);
        $this->assertOwned($request, $customer);

        /** @var PaymentMethod|null $method */
        $method = $config->paymentMethods()
            ->wherePivot('pos_config_id', $config->getKey())
            ->where('payment_methods.id', (int) $request->validated('payment_method_id'))
            ->first();

        if ($method === null) {
            return new JsonResponse(
                ['error' => ['code' => 'settlement_refused', 'message' => 'That payment method is not on this register.']],
                422,
            );
        }

        /** @var PosSession|null $session */
        $session = $config->currentSession()->first();

        if ($session === null) {
            // Without a session there is nowhere for the money to be counted, which is the whole
            // point of taking it here rather than in a back office.
            return new JsonResponse(
                ['error' => ['code' => 'settlement_refused', 'message' => 'Settling a tab needs an open session.']],
                422,
            );
        }

        try {
            $move = $this->ledger->settle($customer, (string) $request->validated('amount'), $method, $session, [
                'employee_id' => $request->validated('employee_id') === null
                    ? null
                    : (int) $request->validated('employee_id'),
                'description' => $request->validated('description'),
            ], deviceId: (int) $device->getKey());
        } catch (InvalidArgumentException|DomainException $e) {
            return new JsonResponse(
                ['error' => ['code' => 'settlement_refused', 'message' => $e->getMessage()]],
                422,
            );
        }

        return new JsonResponse([
            'uuid' => (string) $move->uuid,
            'amount' => (string) $move->amount,
            'balance_after' => (string) $move->balance_after,
        ] + $this->statement($customer->refresh()), 201);
    }

    /** @return array<string, mixed> */
    private function statement(Customer $customer): array
    {
        $moves = CustomerAccountMove::query()
            ->where('customer_id', $customer->getKey())
            ->orderByDesc('occurred_at')
            ->orderByDesc('id')
            ->limit(self::StatementLimit)
            ->get();

        return [
            'customer_id' => (int) $customer->getKey(),
            // The cache, and the sum of the moves. They are returned separately rather than
            // silently reconciled: if they ever disagree, the caller should be able to see it
            // rather than be handed whichever one this method happened to prefer.
            'balance' => (string) $customer->account_balance,
            'ledger_balance' => $this->ledger->balance($customer),
            'moves' => $moves->map(static fn (CustomerAccountMove $move): array => [
                'uuid' => (string) $move->uuid,
                'move_type' => $move->move_type->value,
                'amount' => (string) $move->amount,
                'balance_after' => (string) $move->balance_after,
                'pos_order_id' => $move->pos_order_id,
                'description' => $move->description,
                'occurred_at' => $move->occurred_at?->toIso8601String(),
            ])->all(),
        ];
    }

    /**
     * A device may only touch customers of its own company.
     *
     * `BelongsToCompany` is opt-in rather than global, so route-model binding will happily resolve
     * another tenant's customer by uuid. Nothing else here would notice.
     */
    private function assertOwned(Request $request, Customer $customer): void
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $customer->company_id === (int) $config->company_id, 404);
    }
}
