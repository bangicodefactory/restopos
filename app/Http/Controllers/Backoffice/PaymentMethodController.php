<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\PaymentMethodType;
use App\Enums\QrCodeMethod;
use App\Enums\SessionState;
use App\Enums\TerminalProvider;
use App\Http\Controllers\Backoffice\Concerns\DetectsRealChanges;
use App\Http\Controllers\Controller;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PaymentProvider;
use App\Models\Pricing\Currency;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
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
    use DetectsRealChanges;

    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', PaymentMethod::class);

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
                // Whether one is set, never what it is. `terminal_config` is `encrypted:array` and
                // listed in the model's `$hidden` for a reason: it holds the terminal's pairing
                // secret and endpoint credentials. Putting it in an Inertia payload would decrypt it
                // straight into the page source of every manager who opens this screen — and into
                // the browser history, and any error reporter watching the props.
                'has_terminal_config' => $m->terminal_config !== null && $m->terminal_config !== [],
                'qr_code_method' => (string) ($m->qr_code_method?->value ?? $m->qr_code_method),
                'default_qr_payload' => $m->default_qr_payload,
                'ledger_code' => $m->ledger_code,
                'sequence' => (int) $m->sequence,
                'active' => (bool) $m->active,
            ])->values()->all(),
            'providers' => PaymentProvider::query()->get(['id', 'name', 'code', 'state'])->all(),
            // Currencies are global ISO reference data with no `company_id`, so there is no scope to
            // apply here — `scopeForPos` is the filter that matters and it is about which are offered
            // at a till, not who owns them.
            'currencies' => Currency::query()->orderBy('code')->get(['id', 'code', 'name'])->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', PaymentMethod::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a payment method.']);
        }

        PaymentMethod::query()->create([
            ...$data,
            'company_id' => $companyId,
            'sequence' => $data['sequence'] ?? ((int) PaymentMethod::query()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Payment method added.');
    }

    public function update(Request $request, PaymentMethod $paymentMethod): RedirectResponse
    {
        Gate::authorize('update', $paymentMethod);

        $data = $this->validated($request, creating: false);

        // BOF-110 — a method in use by an **open session** is frozen except for `sequence`.
        //
        // Odoo does exactly this, and the reason is arithmetic rather than ceremony: the session's
        // expected-cash figure and its payment totals were computed against this method as it was
        // when the session opened. Flip `is_cash_count` at lunchtime and the drawer that balanced at
        // 11am is short at close, with nothing on the report explaining why. `sequence` is exempt
        // because it only decides button order.
        // What the save would actually *move*, not which keys arrived. The editor is one
        // `useForm` and posts all sixteen fields on every save, so keying off presence made the
        // `sequence` exemption dead through the real UI: a reorder mid-service was refused by a
        // message saying only the order could be changed. Probed: 422 on a full-form payload whose
        // only edit was `sequence` (review of #85).
        $changed = $this->realChanges($paymentMethod, $data, self::FROZEN_KEYS);

        if ($changed !== [] && $this->usedByOpenSession($paymentMethod)) {
            throw ValidationException::withMessages([
                'name' => 'A session is open on a register that uses this method. Only its order can be'
                    .' changed until the session closes.',
            ]);
        }

        $paymentMethod->forceFill($data)->save();

        return back()->with('success', 'Payment method saved.');
    }

    /**
     * `DELETE /payment-methods/{paymentMethod}` — remove a method (BOF-110).
     *
     * Refused once money has gone through it. `pos_payments` and the session payment summaries both
     * hold `restrictOnDelete`, so the alternative is the database refusing as a 500 with nothing
     * naming the cause — and the right answer is almost always **deactivate**, which takes the method
     * off every till and leaves every past sale and report intact.
     */
    public function destroy(Request $request, PaymentMethod $paymentMethod): RedirectResponse
    {
        Gate::authorize('delete', $paymentMethod);

        $payments = $this->connection->table('pos_payments')
            ->where('payment_method_id', $paymentMethod->getKey())
            ->count();

        if ($payments > 0) {
            throw ValidationException::withMessages([
                'method' => 'This method has taken '.$payments.' payment(s) and cannot be removed.'
                    .' Deactivate it instead — it disappears from the tills and the history stays intact.',
            ]);
        }

        $summarised = $this->connection->table('session_payment_totals')
            ->where('payment_method_id', $paymentMethod->getKey())
            ->count();

        if ($summarised > 0) {
            throw ValidationException::withMessages([
                'method' => 'This method appears on '.$summarised.' closed session report(s) and cannot be'
                    .' removed. Deactivate it instead.',
            ]);
        }

        $this->connection->transaction(function () use ($paymentMethod): void {
            // The register pivot cascades on its own; cleared explicitly so a method cannot briefly
            // exist on a till that no longer has it.
            $this->connection->table('pos_config_payment_method')
                ->where('payment_method_id', $paymentMethod->getKey())
                ->delete();

            $paymentMethod->delete();
        });

        return back()->with('success', 'Payment method removed.');
    }

    /**
     * Everything an open session freezes — that is, every column except `sequence`.
     *
     * `sequence` is exempt because it only decides the order buttons appear in on the payment
     * screen. Everything else feeds the session's arithmetic or its reconciliation.
     *
     * @var list<string>
     */
    private const FROZEN_KEYS = [
        'name',
        'method_type',
        'currency_id',
        'is_cash_count',
        'identify_customer',
        'allow_change',
        'allow_refund',
        'is_rounding_target',
        'terminal_provider',
        'payment_provider_id',
        'terminal_config',
        'qr_code_method',
        'default_qr_payload',
        'ledger_code',
        'image_media_id',
        'active',
    ];

    /** Is any register using this method currently mid-session? */
    private function usedByOpenSession(PaymentMethod $method): bool
    {
        $sessions = $this->connection->table('pos_sessions')
            ->join('pos_config_payment_method', 'pos_config_payment_method.pos_config_id', '=', 'pos_sessions.pos_config_id')
            ->where('pos_config_payment_method.payment_method_id', $method->getKey())
            ->whereIn('pos_sessions.state', [SessionState::Opened->value, SessionState::ClosingControl->value]);

        // Scoped like every other raw builder query on a company-owned table. The method is already
        // this tenant's, so its registers are too — but `TenantIsolationTest` checks the shape rather
        // than the reasoning, and it is right to: the reasoning is what stops being true the day this
        // query grows another join.
        ActingCompany::scope($sessions, 'pos_sessions.company_id');

        return $sessions->exists();
    }

    /**
     * The whole rule set, including the three the tills branch on.
     *
     * `method_type`, `terminal_provider` and `currency_id` were all absent (BAN-424). Between them
     * they decide whether a tender counts into the drawer, which driver the payment screen talks to,
     * and what unit the amount is in — so a seeded method could never be repointed at a real
     * terminal, and a venue could not add the card machine it actually owns.
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        $data = $request->validate([
            'name' => [$required, 'string', 'max:64'],
            // Cash, bank or pay-later. The register branches on this for whether change may be
            // given and whether the tender is counted in the drawer.
            'method_type' => [$required, Rule::enum(PaymentMethodType::class)],
            'currency_id' => [$required, 'integer', Rule::exists('currencies', 'id')],
            'terminal_provider' => ['sometimes', Rule::enum(TerminalProvider::class)],
            'payment_provider_id' => ['sometimes', 'nullable', 'integer'],
            // Provider-specific and schema-less by nature: a terminal's pairing id, its poi id, its
            // endpoint. Validated as *shape* only, because the keys differ per driver and inventing
            // a schema here would mean a second one to keep in sync with every integration.
            'terminal_config' => ['sometimes', 'nullable', 'array'],
            'qr_code_method' => ['sometimes', Rule::enum(QrCodeMethod::class)],
            'default_qr_payload' => ['sometimes', 'nullable', 'string', 'max:4096'],
            // Accepted so the column is not the barrier, but no control is rendered for it: there is
            // no media *upload* route anywhere in the app — only `GET /api/media/{id}` to serve one —
            // so a picker would offer a choice of nothing. Stated rather than dressed up as a locked
            // field pretending the endpoint is the problem.
            'image_media_id' => ['sometimes', 'nullable', 'integer', Rule::exists('media_files', 'id')],

            'is_cash_count' => ['sometimes', 'boolean'],
            'identify_customer' => ['sometimes', 'boolean'],
            'allow_change' => ['sometimes', 'boolean'],
            'allow_refund' => ['sometimes', 'boolean'],
            'is_rounding_target' => ['sometimes', 'boolean'],
            'ledger_code' => ['sometimes', 'nullable', 'string', 'max:32'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        // Resolved through the scoped model rather than an `exists` rule with a company clause: the
        // scope answers `UNRESTRICTED` for a super-admin, so the rule form would block the one
        // account allowed to act across companies.
        if (! empty($data['payment_provider_id'])
            && ! PaymentProvider::query()->whereKey((int) $data['payment_provider_id'])->exists()) {
            throw ValidationException::withMessages(['payment_provider_id' => 'No such payment provider.']);
        }

        return $data;
    }
}
