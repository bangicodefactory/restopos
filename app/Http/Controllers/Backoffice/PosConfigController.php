<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\AccessLevel;
use App\Enums\AuditSeverity;
use App\Enums\DeviceType;
use App\Enums\PaymentMethodType;
use App\Enums\SessionState;
use App\Enums\SpecialKind;
use App\Http\Controllers\Backoffice\Concerns\DetectsRealChanges;
use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\CreatePosConfigRequest;
use App\Http\Requests\Backoffice\PosConfigRequest;
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
use App\Models\Pricing\CashRounding;
use App\Models\Pricing\Currency;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Services\Audit\AuditRecorder;
use App\Services\Device\DevicePairingService;
use App\Support\Audit\AuditEvent;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
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
    use DetectsRealChanges;

    /**
     * The pivots a duplicate carries over.
     *
     * `trustedConfigs` is deliberately absent: trust between registers is a statement about two
     * specific tills, and copying it would silently grant a brand-new register the right to read
     * another's orders.
     *
     * @var list<string>
     */
    private const DUPLICATED_PIVOTS = [
        'paymentMethods', 'pricelists', 'fiscalPositions', 'presets', 'printers',
        'limitedCategories', 'employees', 'floors', 'prepDisplays', 'notes', 'bills',
    ];

    public function __construct(
        private readonly DevicePairingService $pairing,
        private readonly AuditRecorder $audit,
        private readonly ConnectionInterface $connection,
    ) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', PosConfig::class);

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
            // The create form needs these and `index()` never sent them. Global ISO reference data
            // with no `company_id`, so there is nothing to scope.
            'currencies' => Currency::query()->orderBy('code')->get(['id', 'code', 'name'])->all(),
        ]);
    }

    /**
     * `POST /pos-configs` — open a register (BAN-472).
     *
     * A venue could not add a second till. The set of registers was whatever the seeder produced,
     * which made onboarding a new shop impossible through the UI.
     *
     * Three fields, then straight to the settings screen. The other eighty columns all have
     * defaults, and asking for them up front is how a create form becomes something people avoid.
     */
    public function store(CreatePosConfigRequest $request): RedirectResponse
    {
        $companyId = $request->companyId();

        if ($companyId === null) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before opening a register.',
            ]);
        }

        $config = PosConfig::query()->create([
            ...$request->validated(),
            'company_id' => $companyId,
            'uuid' => (string) Str::uuid(),
            // Never copied and never client-supplied: it is the broadcast channel name and the
            // self-order entry token at once.
            'access_token' => PosConfig::newAccessToken(),
        ]);

        return redirect()
            ->route('pos-configs.edit', $config->uuid)
            ->with('success', 'Register opened. Its settings are below.');
    }

    /**
     * `POST /pos-configs/{config}/duplicate` — copy a register (BAN-472).
     *
     * The reason this exists rather than "create and configure it again": a second till in the same
     * venue differs from the first in its name and almost nothing else, and the settings screen has
     * eleven tabs. Reproducing them by hand is where a venue ends up with two registers that quietly
     * disagree about tax display or cash rounding.
     *
     * Copies the scalar settings and every pivot **except** the cash payment methods. A cash method
     * belongs to exactly one register (BOF-110): two tills sharing one means two sessions
     * reconciling against the same drawer, and each computes its expected cash from that method — so
     * a float on one is expected in the other's count, and nobody sees it until a drawer is short.
     */
    public function duplicate(PosConfig $config): RedirectResponse
    {
        Gate::authorize('create', PosConfig::class);
        Gate::authorize('view', $config);

        $copy = $this->connection->transaction(function () use ($config): PosConfig {
            $attributes = $config->attributesToArray();

            foreach (['id', 'uuid', 'access_token', 'config_revision', 'last_config_change_at', 'created_at', 'updated_at', 'deleted_at'] as $owned) {
                unset($attributes[$owned]);
            }

            /** @var PosConfig $copy */
            $copy = PosConfig::query()->create([
                ...$attributes,
                'company_id' => $config->company_id,
                'name' => $this->availableName($config),
                'uuid' => (string) Str::uuid(),
                'access_token' => PosConfig::newAccessToken(),
            ]);

            foreach (self::DUPLICATED_PIVOTS as $relation) {
                $ids = $config->{$relation}()->pluck($config->{$relation}()->getRelated()->getQualifiedKeyName())->all();

                if ($relation === 'paymentMethods') {
                    $ids = PaymentMethod::query()
                        ->whereKey($ids)
                        ->where('is_cash_count', false)
                        ->pluck('id')
                        ->all();
                }

                $copy->{$relation}()->sync($ids);
            }

            return $copy;
        });

        return redirect()
            ->route('pos-configs.edit', $copy->uuid)
            ->with('success', 'Register copied. Its cash payment methods were not copied — a cash method belongs to one register.');
    }

    /**
     * `DELETE /pos-configs/{config}` — archive a register (BAN-472).
     *
     * Archived, never deleted. Every session, order and payment this register took names it, so the
     * row has to stay for those to mean anything — and `pos_orders.pos_config_id` is
     * `restrictOnDelete` besides, so a hard delete is a 500 with nothing naming the cause.
     *
     * Refused while a session is open: closing a register mid-service strands the drawer count.
     */
    public function destroy(PosConfig $config): RedirectResponse
    {
        Gate::authorize('delete', $config);

        if ($this->hasOpenSession($config)) {
            throw ValidationException::withMessages([
                'config' => 'This register has a session open. Close it before archiving the register.',
            ]);
        }

        $config->forceFill(['active' => false])->save();
        $config->bumpRevision();

        return back()->with('success', 'Register archived. It no longer appears on any till.');
    }

    /** A copy is named "Bar (2)", then "Bar (3)" — `name` has no unique index, but two identical rows in a list are useless. */
    private function availableName(PosConfig $config): string
    {
        $taken = PosConfig::query()->pluck('name')->all();
        $base = (string) $config->name;

        for ($n = 2; $n < 100; $n++) {
            $candidate = $base.' ('.$n.')';

            if (! in_array($candidate, $taken, true)) {
                return mb_substr($candidate, 0, 96);
            }
        }

        return mb_substr($base.' ('.Str::lower(Str::random(4)).')', 0, 96);
    }

    public function edit(PosConfig $config): Response
    {
        Gate::authorize('view', $config);

        $config->load(['paymentMethods', 'pricelists', 'fiscalPositions', 'presets', 'printers', 'limitedCategories', 'employees', 'floors', 'prepDisplays']);

        return Inertia::render('PosConfigs/Edit', [
            'config' => $config->attributesToArray() + [
                'access_token' => (string) $config->access_token,
                // So the editor can lock the four frozen fields with a reason rather than letting
                // the operator change them, press save, and be refused (BAN-469). A greyed control
                // that says why is the whole convention on this screen.
                'has_open_session' => $this->hasOpenSession($config),
                'payment_method_ids' => $config->paymentMethods->pluck('id')->all(),
                'pricelist_ids' => $config->pricelists->pluck('id')->all(),
                'fiscal_position_ids' => $config->fiscalPositions->pluck('id')->all(),
                'preset_ids' => $config->presets->pluck('id')->all(),
                'printer_ids' => $config->printers->pluck('id')->all(),
                'limited_category_ids' => $config->limitedCategories->pluck('id')->all(),
                'employee_ids' => $config->employees->pluck('id')->all(),
                // The level each of them holds *here*, so the editor can render it rather than
                // showing every attached employee at the column default (BOF-117).
                'employee_access_levels' => $config->employees
                    ->mapWithKeys(static fn ($e): array => [
                        (string) $e->getKey() => (string) ($e->pivot->access_level ?? AccessLevel::Basic->value),
                    ])->all(),
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
                // BOF-033. The rule the register rounds a cash total to — 0.05 where one-cent coins
                // are gone. Offered here because `cash_rounding_id` is meaningless without it.
                'cash_roundings' => CashRounding::query()->orderBy('name')
                    ->get(['id', 'name', 'rounding', 'rounding_method'])->all(),
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
                // What an override starts from. Without these the editor would show empty rows and
                // an operator would have to know the default ability set by heart to reproduce it.
                'ability_defaults' => (array) config('pos.role_abilities', []),
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

    public function update(PosConfigRequest $request, PosConfig $config): RedirectResponse
    {
        // `PosConfigRequest::authorize()` runs the policy; this controller used to sit behind
        // `auth` alone, so any signed-in user could rewrite any register's settings (BAN-466).
        $data = $request->validated();

        // BOF-032 — a default service mode the register does not offer is a till whose opening
        // screen names a mode it then refuses. The editor already adds it to the list, but the
        // editor is not the only way in: this is a `PATCH` a script can make directly.
        //
        // Widened rather than refused, because the operator's intent is unambiguous — they picked
        // this preset as the default, so they want it available.
        $defaultPreset = (int) ($data['default_preset_id'] ?? $config->default_preset_id ?? 0);

        if ($defaultPreset !== 0 && array_key_exists('preset_ids', $data)) {
            $chosen = array_map(intval(...), (array) $data['preset_ids']);

            if (! in_array($defaultPreset, $chosen, true)) {
                $data['preset_ids'] = [...$chosen, $defaultPreset];
            }
        }

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

        $this->assertNotFrozen($config, $data);

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

        // BOF-117 — the level an employee holds *on this register* (BAN-446).
        //
        // `pos_config_employee.access_level` has existed since the table was written, with a CHECK
        // constraint and a default of `basic`, and the sync wrote bare ids — so every employee
        // attached to every register sat at the default and "this cashier is a manager on till 2
        // only" could not be expressed at all.
        $levels = [];

        foreach ((array) ($data['employee_access_levels'] ?? []) as $employeeId => $level) {
            $levels[(int) $employeeId] = ['access_level' => (string) $level];
        }

        unset($data['employee_access_levels']);

        foreach ($pivots as $key => $relation) {
            if (array_key_exists($key, $data)) {
                $pivotBefore[$key] = $this->pivotIds($config, $relation);
                $owned = $this->ownedIds($config, $relation, (array) $data[$key], $key);

                // Levels are attached to the ids that survived the ownership check, never to the
                // submitted ones — a level keyed to an id from another company would otherwise
                // re-introduce through the pivot payload exactly what `ownedIds` just refused.
                $config->{$relation}()->sync(
                    $relation === 'employees'
                        ? array_combine($owned, array_map(
                            static fn (int $id): array => $levels[$id] ?? [],
                            $owned,
                        ))
                        : $owned,
                );

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
     * The fields Odoo calls `_get_forbidden_change_fields` (BOF-030, BAN-469).
     *
     * Each one corrupts an open session rather than merely inconveniencing it, and probed on master
     * all four went through with a 302 while a session was running:
     *
     *  - **`active`** — archiving strands the session. `destroy()` refuses this, and BAN-466 made
     *    `active` writable through `update`, so the guard had a door beside it.
     *  - **`is_restaurant`** — turns off floors, tables and course firing on a register that has
     *    seated orders. The floor screen disappears with bills still open on it.
     *  - **`payment_method_ids`** — an open order tendered against a method that has just been
     *    removed cannot be settled, and the session's expected-cash figure was computed from a set
     *    of methods that no longer matches the one it will be reconciled against.
     *  - **`floor_ids`** — seated orders point at tables this register no longer serves, so the
     *    bills exist and no screen can reach them.
     *
     * **Keyed off what actually moves, not off what the request mentions.** The settings screen is
     * one `useForm` posting every field on every save, so a presence check would refuse a save whose
     * only edit was a receipt footer — which is the mistake `DetectsRealChanges` was written for
     * after the same thing made the `sequence` exemption dead on payment methods (review of #85).
     *
     * @param  array<string, mixed>  $data
     */
    private function assertNotFrozen(PosConfig $config, array $data): void
    {
        $moved = $this->realChanges($config, $data, ['active', 'is_restaurant']);

        foreach (['payment_method_ids' => 'paymentMethods', 'floor_ids' => 'floors'] as $key => $relation) {
            if (array_key_exists($key, $data) && $this->selectionMoves($config, $relation, (array) $data[$key])) {
                $moved[] = $key;
            }
        }

        if ($moved === [] || ! $this->hasOpenSession($config)) {
            return;
        }

        // Named individually rather than as one blanket message: an operator who changed four
        // settings and had the save refused needs to know which one to put back, and a message
        // saying "some of these are locked" makes them undo all four.
        $reasons = [
            'active' => 'archiving it would strand the session that is running on it',
            'is_restaurant' => 'turning restaurant mode off takes away the floor screen while bills are open on it',
            'payment_method_ids' => 'an order already tendered against a method removed now could not be settled, and the drawer would be counted against a different set of methods than it was opened with',
            'floor_ids' => 'seated orders would point at tables this register no longer serves, so the bills would exist with no screen able to reach them',
        ];

        throw ValidationException::withMessages(
            array_map(
                static fn (string $reason): string => 'This register has a session open — '.$reason
                    .'. It can be changed once the session closes.',
                array_intersect_key($reasons, array_flip($moved)),
            ),
        );
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
        // Pairing mints a long-lived device token, so it is checked separately from a settings save.
        Gate::authorize('pairDevice', $config);

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
