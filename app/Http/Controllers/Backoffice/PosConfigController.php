<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\AuditSeverity;
use App\Enums\DeviceType;
use App\Enums\PaymentMethodType;
use App\Enums\SessionState;
use App\Enums\SpecialKind;
use App\Http\Controllers\Controller;
use App\Http\Requests\Device\CreatePairingCodeRequest;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Identity\Employee;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosBill;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosNote;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PosPrinter;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Services\Audit\AuditRecorder;
use App\Services\Device\DevicePairingService;
use App\Support\Audit\AuditEvent;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `PosConfigs/Index` and `PosConfigs/Edit` — the widest settings surface in the
 * product (spec 02 BOF-030…BOF-079).
 *
 * Any client-visible change bumps `config_revision`, which is the signal a
 * register uses to discard its IndexedDB cache and re-bootstrap. Forgetting to
 * bump it is how a tenant ends up with tills selling at last week's prices.
 */
final class PosConfigController extends Controller
{
    public function __construct(
        private readonly DevicePairingService $pairing,
        private readonly AuditRecorder $audit,
        private readonly ConnectionInterface $connection,
    ) {}

    public function index(): Response
    {
        return Inertia::render('PosConfigs/Index', [
            'configs' => PosConfig::query()->orderBy('name')->get()->map(static fn (PosConfig $c): array => [
                'id' => (int) $c->getKey(),
                'uuid' => (string) $c->uuid,
                'name' => (string) $c->name,
                'active' => (bool) $c->active,
                'is_restaurant' => (bool) $c->is_restaurant,
                'self_ordering_mode' => $c->self_ordering_mode->value,
                'currency_id' => (int) $c->currency_id,
                'config_revision' => (int) $c->config_revision,
            ])->values()->all(),
        ]);
    }

    public function edit(PosConfig $config): Response
    {
        $config->load(['paymentMethods', 'pricelists', 'fiscalPositions', 'presets', 'printers', 'limitedCategories', 'employees', 'floors', 'prepDisplays']);

        return Inertia::render('PosConfigs/Edit', [
            'config' => $config->attributesToArray() + [
                'access_token' => (string) $config->access_token,
                'payment_method_ids' => $config->paymentMethods->pluck('id')->all(),
                'pricelist_ids' => $config->pricelists->pluck('id')->all(),
                'fiscal_position_ids' => $config->fiscalPositions->pluck('id')->all(),
                'preset_ids' => $config->presets->pluck('id')->all(),
                'printer_ids' => $config->printers->pluck('id')->all(),
                'limited_category_ids' => $config->limitedCategories->pluck('id')->all(),
                'employee_ids' => $config->employees->pluck('id')->all(),
                'floor_ids' => $config->floors->pluck('id')->all(),
                'prep_display_ids' => $config->prepDisplays->pluck('id')->all(),
                // Both are "empty means all", which the pages have to say out loud or an empty
                // picker reads as "this register has no notes" rather than "it has every note".
                'note_ids' => $config->notes->pluck('id')->all(),
                'bill_ids' => $config->bills->pluck('id')->all(),
            ],
            'options' => Inertia::defer(fn (): array => [
                'payment_methods' => PaymentMethod::query()->orderBy('sequence')->get(['id', 'name', 'method_type', 'is_cash_count'])->all(),
                'pricelists' => Pricelist::query()->orderBy('name')->get(['id', 'name', 'currency_id'])->all(),
                'fiscal_positions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),
                'presets' => PosPreset::query()->orderBy('sequence')->get(['id', 'name', 'service_at'])->all(),
                'printers' => PosPrinter::query()->orderBy('name')->get(['id', 'name', 'printer_type'])->all(),
                'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all(),
                // RST-120 — only products marked as tips, which is a handful by definition. A
                // catalogue-wide picker would be a search box, not a select, and the tip product is
                // not something a manager browses for.
                'tip_products' => Product::query()
                    ->where('special_kind', SpecialKind::Tip->value)
                    ->orderBy('name')
                    ->get(['id', 'name'])
                    ->all(),
                'employees' => Employee::query()->where('active', true)->orderBy('name')->get(['id', 'name', 'default_role'])->all(),
                'notes' => PosNote::query()->orderBy('sequence')->get(['id', 'name', 'note_scope'])->all(),
                'bills' => PosBill::query()->orderBy('currency_id')->orderBy('sequence')
                    ->get(['id', 'name', 'value', 'currency_id'])->all(),
            ]),
            'devices' => Inertia::defer(fn (): array => $config->devices()->orderBy('device_identifier')->get()
                ->map(static fn ($d): array => [
                    'id' => (int) $d->getKey(),
                    'uuid' => (string) $d->uuid,
                    'name' => $d->name,
                    'device_identifier' => (int) $d->device_identifier,
                    'device_type' => $d->device_type->value,
                    'last_seen_at' => $d->last_seen_at,
                    'active' => (bool) $d->active,
                ])->values()->all()),
        ]);
    }

    public function update(Request $request, PosConfig $config): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            'active' => ['sometimes', 'boolean'],
            'is_restaurant' => ['sometimes', 'boolean'],
            'use_pricelists' => ['sometimes', 'boolean'],
            'limit_categories' => ['sometimes', 'boolean'],
            'use_fiscal_positions' => ['sometimes', 'boolean'],
            'has_cash_control' => ['sometimes', 'boolean'],
            'set_maximum_difference' => ['sometimes', 'boolean'],
            'amount_authorized_diff' => ['sometimes', 'nullable', 'numeric'],
            'use_preparation_display' => ['sometimes', 'boolean'],
            'use_preparation_printers' => ['sometimes', 'boolean'],
            'use_employee_login' => ['sometimes', 'boolean'],
            'enable_tips' => ['sometimes', 'boolean'],
            // RST-120, RST-122 (BAN-522). Both columns have existed since the config table was
            // written and neither was settable: the register could not be put into tip-after-payment
            // mode from the back office at all, and `tip_product_id` — the product a tip is booked
            // against — could only be set by editing the database.
            //
            // The product is scoped to the company rather than merely required to exist: it names a
            // row this venue's tips are posted to, and an unscoped `exists` is the hole BAN-520
            // closed on the ingest side of the same kind of reference.
            'tip_after_payment' => ['sometimes', 'boolean'],
            'tip_product_id' => [
                'sometimes',
                'nullable',
                'integer',
                Rule::exists('products', 'id')->where('company_id', $config->company_id),
            ],
            'enable_split_bill' => ['sometimes', 'boolean'],
            'enable_global_discount' => ['sometimes', 'boolean'],
            'global_discount_percent' => ['sometimes', 'numeric', 'min:0', 'max:100'],
            'limited_product_count' => ['sometimes', 'integer', 'min:1'],
            'limited_customer_count' => ['sometimes', 'integer', 'min:1'],
            'receipt_header' => ['sometimes', 'nullable', 'string'],
            'receipt_footer' => ['sometimes', 'nullable', 'string'],
            'payment_method_ids' => ['sometimes', 'array'],
            'pricelist_ids' => ['sometimes', 'array'],
            'fiscal_position_ids' => ['sometimes', 'array'],
            'preset_ids' => ['sometimes', 'array'],
            'printer_ids' => ['sometimes', 'array'],
            'limited_category_ids' => ['sometimes', 'array'],
            'employee_ids' => ['sometimes', 'array'],
            'floor_ids' => ['sometimes', 'array'],
            'prep_display_ids' => ['sometimes', 'array'],
            'note_ids' => ['sometimes', 'array'],
            'note_ids.*' => ['integer'],
            'bill_ids' => ['sometimes', 'array'],
            'bill_ids.*' => ['integer'],
        ]);

        $pivots = [
            'payment_method_ids' => 'paymentMethods',
            'pricelist_ids' => 'pricelists',
            'fiscal_position_ids' => 'fiscalPositions',
            'preset_ids' => 'presets',
            'printer_ids' => 'printers',
            'limited_category_ids' => 'limitedCategories',
            'employee_ids' => 'employees',
            'floor_ids' => 'floors',
            'prep_display_ids' => 'prepDisplays',
            'note_ids' => 'notes',
            'bill_ids' => 'bills',
        ];

        // The pivots are read *before* the sync that overwrites them. They were originally left out
        // of the trail because the diff below only sees scalar columns — but "who added a payment
        // method to this register", "who granted this employee access to that till" and "who
        // attached a pricelist" are the config changes with the most reach, and they all live here.
        // A trail that records the checkbox next to them and not them is the wrong half.
        // BOF-110 — a cash method belongs to exactly one register (BAN-424).
        //
        // Two tills sharing one cash method means two sessions reconciling against the same drawer:
        // each computes its own expected cash from that method, so a float or a cash movement on one
        // is expected in the other's count. Nobody sees it until a drawer is short, and then the
        // report blames the cashier. Probed before this guard — the same method sat on two registers
        // and nothing objected (review of #82).
        if (array_key_exists('payment_method_ids', $data)) {
            $this->assertCashMethodsUnshared($config, array_map(intval(...), (array) $data['payment_method_ids']));
        }

        // BOF-039 — the notes a register offers are frozen while it has a session open.
        //
        // The list is not decoration: a predefined note is the wording the kitchen reads and, for
        // allergies, acts on. Take "allergy - nuts" off the register mid-service and the next order
        // that needs it gets a free-typed approximation, or nothing. Orders already sent keep the
        // text they were sent with, so the ticket in the pass and the picker at the till stop
        // agreeing about what the venue's notes even are.
        //
        // Denominations are deliberately *not* frozen: the count sheet is read at close, so a
        // correction made mid-shift is applied to the count that has not happened yet.
        if (array_key_exists('note_ids', $data)
            && $this->selectionMoves($config, 'notes', (array) $data['note_ids'])
            && $this->hasOpenSession($config)) {
            throw ValidationException::withMessages([
                'note_ids' => 'This register has a session open. The notes it offers can be changed'
                    .' once the session closes — the kitchen is already reading this list.',
            ]);
        }

        $pivotBefore = [];

        foreach ($pivots as $key => $relation) {
            if (array_key_exists($key, $data)) {
                $pivotBefore[$key] = $this->pivotIds($config, $relation);
                $config->{$relation}()->sync($this->ownedIds($config, $relation, (array) $data[$key], $key));
                unset($data[$key]);
            }
        }

        // Snapshot before the write, and diff after — a register's settings are where the money
        // rules live (`amount_authorized_diff` is the variance a manager may wave through,
        // `has_cash_control` decides whether the drawer is counted at all). "Who turned cash
        // control off, and when" is a question an auditor asks and nothing could answer (BAN-413).
        $before = array_intersect_key($config->getOriginal(), $data);

        $config->forceFill($data)->save();

        $changes = AuditRecorder::diff($before, $data);

        foreach ($pivotBefore as $key => $wasIds) {
            $nowIds = $this->pivotIds($config->refresh(), $pivots[$key]);

            $added = array_values(array_diff($nowIds, $wasIds));
            $removed = array_values(array_diff($wasIds, $nowIds));

            // Decided by set difference, not by comparing the two lists. Neither `pluck` carries an
            // `ORDER BY`, so no database promises to hand the same membership back in the same order
            // twice — and `sync()` deletes and re-inserts rows, which is exactly when the physical
            // order changes. An equality check would have logged a settings change every time the
            // rows came back shuffled. SQLite happens to be stable here, so a test could not have
            // caught it; the fix is to not depend on the ordering in the first place.
            if ($added === [] && $removed === []) {
                continue;
            }

            // The split is spelled out because an auditor wants "employee 12 gained access", not
            // two arrays to difference by eye.
            $changes[$key] = [
                'old' => $wasIds,
                'new' => $nowIds,
                'added' => $added,
                'removed' => $removed,
            ];
        }

        if ($changes !== []) {
            $this->audit->record(
                event: AuditEvent::ConfigChanged,
                subject: $config,
                severity: AuditSeverity::Notice,
                message: "Register {$config->name} settings changed",
                changes: $changes,
                config: $config,
            );
        }

        // Every client-visible edit invalidates every register's cache.
        $config->bumpRevision();

        return back()->with('success', 'Register settings saved.');
    }

    /**
     * Resolve submitted pivot ids through the *scoped* model, refusing anything that is not ours.
     *
     * `sync()` writes whatever ids it is handed. Every one of these eleven pivots took them straight
     * from the request, so a manager could attach another company's payment method, employee,
     * printer, category, floor, pricelist, fiscal position, preset or kitchen screen to their own
     * register — probed on master: a foreign payment method and a foreign category both attached and
     * the save reported success (XCT-101).
     *
     * That is not a cosmetic leak. A foreign payment method appears on this register's payment
     * screen and its takings land in this venue's session; a foreign employee is granted till access
     * they were never given.
     *
     * Refused rather than filtered, for the same reason as the printer and kitchen-screen category
     * pivots (BAN-432, BAN-435): silently dropping an id means the operator ticks a box, the save
     * succeeds, and the setting is simply not there.
     *
     * @param  list<mixed>  $ids
     * @return list<int>
     */
    private function ownedIds(PosConfig $config, string $relation, array $ids, string $field): array
    {
        $wanted = array_values(array_unique(array_map(intval(...), $ids)));

        if ($wanted === []) {
            return [];
        }

        $related = $config->{$relation}()->getRelated();

        // `newQuery()` carries the model's global company scope, which is the whole point: an id
        // belonging to another tenant simply does not come back.
        $found = $related->newQuery()->whereKey($wanted)->pluck($related->getKeyName())
            ->map(static fn (mixed $v): int => (int) $v)->all();

        $missing = array_values(array_diff($wanted, $found));

        if ($missing !== []) {
            throw ValidationException::withMessages([
                $field => 'No such record: '.implode(', ', $missing).'.',
            ]);
        }

        return $found;
    }

    /**
     * Would syncing this list actually change the selection?
     *
     * Compared as a *set*, not as two lists. Neither side carries an `ORDER BY`, and the page posts
     * whatever order the operator's clicks left behind — so an equality check would refuse a save
     * that changed nothing, which is the defect this project has now hit twice under other names
     * (BAN-396, BAN-424).
     *
     * @param  list<mixed>  $submitted
     */
    private function selectionMoves(PosConfig $config, string $relation, array $submitted): bool
    {
        $now = $this->pivotIds($config, $relation);
        $next = array_values(array_unique(array_map(intval(...), $submitted)));

        sort($now);
        sort($next);

        return $now !== $next;
    }

    /** Is a session open on this register right now? */
    private function hasOpenSession(PosConfig $config): bool
    {
        $query = $this->connection->table('pos_sessions')
            ->where('pos_config_id', $config->getKey())
            ->whereIn('state', [SessionState::Opened->value, SessionState::ClosingControl->value]);

        // Redundant against the `pos_config_id` filter, since the config was resolved through the
        // scoped model — but `pos_sessions` carries a `company_id` and `TenantIsolationTest` holds
        // every raw query on a company-owned table to the same rule rather than to a case-by-case
        // argument. It caught this one, which is the third time this run.
        ActingCompany::scope($query);

        return $query->exists();
    }

    /**
     * The ids currently attached through one pivot.
     *
     * Sorted for the reader's benefit only — the change decision above is a set difference and does
     * not depend on it. Storing `[3, 7, 12]` rather than whatever order the rows came back in is
     * what makes two audit rows comparable by eye a month later.
     *
     * @return list<int>
     */
    private function pivotIds(PosConfig $config, string $relation): array
    {
        $ids = $config->{$relation}()->pluck($config->{$relation}()->getRelated()->getTable().'.id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all();

        sort($ids);

        return $ids;
    }

    /** `POST /backoffice/pos-configs/{config}/pairing-codes` (spec 03 §2.2). */
    public function pairingCode(CreatePairingCodeRequest $request, PosConfig $config): JsonResponse
    {
        return new JsonResponse($this->pairing->createCode(
            $config,
            DeviceType::from((string) $request->validated('device_type')),
            $request->validated('name'),
            $request->user()?->getKey() === null ? null : (int) $request->user()->getKey(),
        ), 201);
    }

    /**
     * Refuse any cash method that is already on a different register (BOF-110).
     *
     * Checked before the sync rather than after, so a refusal leaves the register exactly as it was
     * — a half-applied set of payment methods is worse than none.
     *
     * @param  list<int>  $methodIds
     */
    private function assertCashMethodsUnshared(PosConfig $config, array $methodIds): void
    {
        if ($methodIds === []) {
            return;
        }

        /** @var list<int> $cashIds */
        $cashIds = PaymentMethod::query()
            ->whereIn('id', $methodIds)
            ->where('method_type', PaymentMethodType::Cash->value)
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        if ($cashIds === []) {
            return;
        }

        $clashes = $this->connection->table('pos_config_payment_method')
            ->join('pos_configs', 'pos_configs.id', '=', 'pos_config_payment_method.pos_config_id')
            ->whereIn('pos_config_payment_method.payment_method_id', $cashIds)
            ->where('pos_config_payment_method.pos_config_id', '!=', $config->getKey());

        ActingCompany::scope($clashes, 'pos_configs.company_id');

        $taken = $clashes->pluck('pos_configs.name')->unique()->values()->all();

        if ($taken !== []) {
            throw ValidationException::withMessages([
                // Named, so the manager knows which register to take it off rather than hunting.
                'payment_method_ids' => 'A cash method may belong to one register only. Already in use on: '
                    .implode(', ', $taken).'.',
            ]);
        }
    }
}
