<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\CustomerRequest;
use App\Models\Identity\Country;
use App\Models\Identity\Customer;
use App\Models\Pos\CustomerAccountMove;
use App\Models\Pos\Order;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Services\Identity\CustomerMerger;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The customer base (BOF-119, BAN-453).
 *
 * There was **no customer route and no customer page of any kind**. Customers ship in the bootstrap
 * payload and can be attached to an order at the till, and that inline picker was the only customer
 * surface in the product: an operator could not look one up, correct a phone number, merge two
 * duplicates, or set the default price list that decides what that customer is charged.
 *
 * ## Deleting
 *
 * A customer with any history is archived, never removed. That is not a policy choice — `pos_invoices`
 * and `customer_account_moves` are both `restrictOnDelete`, so the database refuses anyway, and it
 * refuses with a 500 rather than a message. This turns it into an answer.
 *
 * ## Duplicates
 *
 * Made at the till, not here: the same regular is entered twice under slightly different names, and
 * the two records split one history — including the account balance. The list surfaces likely pairs
 * so they can be merged rather than left to diverge.
 */
final class CustomerController extends Controller
{
    /** How many rows one screen carries. The list reports the total so a cut is never silent. */
    private const PAGE = 500;

    public function index(Request $request): Response
    {
        Gate::authorize('viewAny', Customer::class);

        $search = trim((string) $request->query('q', ''));

        return Inertia::render('Customers/Index', [
            'customers' => Customer::query()
                ->when($search !== '', fn ($query) => $query->where(function ($q) use ($search): void {
                    $like = '%'.$search.'%';
                    $q->where('name', 'like', $like)
                        ->orWhere('email', 'like', $like)
                        ->orWhere('phone', 'like', $like)
                        ->orWhere('mobile', 'like', $like)
                        ->orWhere('vat', 'like', $like)
                        ->orWhere('barcode', 'like', $like);
                }))
                ->orderBy('name')
                // A venue's customer base outgrows a page long before it outgrows the database, and
                // the count below says so rather than letting the list read as complete.
                ->limit(self::PAGE)
                ->get()
                ->map(static fn (Customer $c): array => [
                    'id' => (int) $c->getKey(),
                    'uuid' => (string) $c->uuid,
                    'name' => (string) $c->name,
                    'is_company' => (bool) $c->is_company,
                    'email' => $c->email,
                    'phone' => $c->phone,
                    'mobile' => $c->mobile,
                    'city' => $c->city,
                    'vat' => $c->vat,
                    'order_count' => (int) $c->order_count,
                    'account_balance' => (string) $c->account_balance,
                    'last_order_at' => $c->last_order_at?->toIso8601String(),
                    'active' => (bool) $c->active,
                ])->values()->all(),
            'search' => $search,
            'total' => Customer::query()->count(),
            'shown_limit' => self::PAGE,
            'duplicates' => $this->likelyDuplicates(),
        ]);
    }

    public function edit(Customer $customer): Response
    {
        Gate::authorize('view', $customer);

        return Inertia::render('Customers/Edit', [
            'customer' => $customer->attributesToArray(),
            // The order history is the reason to open this page at all — "when were they last in,
            // and what do they owe" is the question a manager brings to a customer record.
            'orders' => Order::query()
                ->where('customer_id', $customer->getKey())
                ->orderByDesc('ordered_at')
                ->limit(50)
                ->get(['id', 'tracking_number', 'state', 'amount_total', 'ordered_at'])
                ->map(static fn (Order $o): array => [
                    'id' => (int) $o->getKey(),
                    'tracking_number' => (string) $o->tracking_number,
                    'state' => (string) $o->state->value,
                    'amount_total' => (string) $o->amount_total,
                    'ordered_at' => $o->ordered_at?->toIso8601String(),
                ])->values()->all(),
            'accountMoves' => CustomerAccountMove::query()
                ->where('customer_id', $customer->getKey())
                ->orderByDesc('occurred_at')
                ->limit(50)
                ->get(['id', 'amount', 'balance_after', 'move_type', 'description', 'occurred_at'])
                ->map(static fn (CustomerAccountMove $m): array => [
                    'id' => (int) $m->getKey(),
                    'amount' => (string) $m->amount,
                    'balance_after' => (string) $m->balance_after,
                    'move_type' => (string) $m->move_type->value,
                    'description' => $m->description,
                    'occurred_at' => $m->occurred_at?->toIso8601String(),
                ])->values()->all(),
            'pricelists' => Pricelist::query()->where('active', true)->orderBy('name')->get(['id', 'name'])->all(),
            'fiscalPositions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),
            'countries' => Country::query()->orderBy('name')->get(['id', 'name'])->all(),
            // Who this record could be merged into. Offered on the record rather than only in the
            // list, because the operator who notices a duplicate is the one already looking at it.
            'mergeCandidates' => $this->candidatesFor($customer),
        ]);
    }

    public function store(CustomerRequest $request): RedirectResponse
    {
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a customer.',
            ]);
        }

        $customer = Customer::query()->create([...$request->validated(), 'company_id' => $companyId]);

        return redirect()
            ->route('customers.edit', $customer->uuid)
            ->with('success', 'Customer added.');
    }

    public function update(CustomerRequest $request, Customer $customer): RedirectResponse
    {
        $customer->forceFill($request->validated())->save();

        return back()->with('success', 'Customer saved.');
    }

    /**
     * Removed only while the record has no history; archived otherwise.
     *
     * The archive is not a lesser outcome. A customer who has ever ordered is part of the record of
     * those orders, and a venue asked to erase one has to weigh that against the invoices it is
     * required to keep — which is a decision, not a button.
     */
    public function destroy(Customer $customer): RedirectResponse
    {
        Gate::authorize('delete', $customer);

        $orders = Order::query()->where('customer_id', $customer->getKey())->count();
        $moves = CustomerAccountMove::query()->where('customer_id', $customer->getKey())->count();

        if ($orders > 0 || $moves > 0) {
            $customer->forceFill(['active' => false])->save();

            return redirect()->route('customers.index')->with(
                'success',
                'This customer has '.$orders.' order(s) and '.$moves.' account move(s), which are'
                    .' part of the record of those sales, so they have been archived rather than'
                    .' removed. They no longer appear at the till, and every past order still names'
                    .' them.'
            );
        }

        $customer->delete();

        return redirect()->route('customers.index')->with('success', 'Customer removed.');
    }

    /**
     * `POST /customers/{customer}/merge` — this record absorbs another.
     *
     * The survivor is the one in the URL. Which way round matters: the survivor keeps its name,
     * contact details and price list, so the operator picks the record they want to keep and merges
     * the other into it.
     */
    public function merge(Request $request, Customer $customer, CustomerMerger $merger): RedirectResponse
    {
        Gate::authorize('merge', $customer);

        $data = $request->validate([
            'loser_id' => ['required', 'integer'],
        ]);

        // Through the scoped model: `Rule::exists` would accept another tenant's customer, and
        // merging one in would move their orders and their account balance onto ours.
        $loser = Customer::query()->whereKey((int) $data['loser_id'])->first();

        if ($loser === null) {
            throw ValidationException::withMessages([
                'loser_id' => 'That customer belongs to another venue, or no longer exists.',
            ]);
        }

        if ((int) $loser->getKey() === (int) $customer->getKey()) {
            throw ValidationException::withMessages([
                'loser_id' => 'A customer cannot be merged into themselves.',
            ]);
        }

        $merger->merge($customer, $loser);

        return back()->with('success', 'Records merged. '.$loser->name.' has been archived.');
    }

    /**
     * Pairs worth a second look.
     *
     * Matched on the three things a duplicate actually shares — an email address, a phone number, a
     * mobile — rather than on the name, which is where the duplicate came from and is therefore the
     * one field that differs. Blank values are excluded: every customer with no email would
     * otherwise match every other.
     *
     * @return list<array{value: string, field: string, ids: list<int>, names: list<string>}>
     */
    private function likelyDuplicates(): array
    {
        $pairs = [];

        foreach (['email', 'phone', 'mobile'] as $field) {
            $rows = Customer::query()
                ->whereNotNull($field)
                ->where($field, '!=', '')
                ->get(['id', 'name', $field])
                ->groupBy($field)
                ->filter(static fn ($group) => $group->count() > 1);

            foreach ($rows as $value => $group) {
                $pairs[] = [
                    'value' => (string) $value,
                    'field' => $field,
                    'ids' => $group->pluck('id')->map(intval(...))->all(),
                    'names' => $group->pluck('name')->all(),
                ];
            }
        }

        return $pairs;
    }

    /**
     * Other records this one could absorb.
     *
     * @return list<array{id: int, name: string, why: string}>
     */
    private function candidatesFor(Customer $customer): array
    {
        $matches = Customer::query()
            ->whereKeyNot($customer->getKey())
            ->where(function ($query) use ($customer): void {
                foreach (['email', 'phone', 'mobile'] as $field) {
                    if (filled($customer->{$field})) {
                        $query->orWhere($field, $customer->{$field});
                    }
                }

                // A name match alone is weak, but it is how most duplicates are spotted by eye, so
                // it is offered — never applied.
                $query->orWhere('name', $customer->name);
            })
            ->limit(20)
            ->get(['id', 'name', 'email', 'phone']);

        return $matches->map(static fn (Customer $c): array => [
            'id' => (int) $c->getKey(),
            'name' => (string) $c->name,
            'why' => (string) ($c->email ?? $c->phone ?? $c->name),
        ])->values()->all();
    }
}
