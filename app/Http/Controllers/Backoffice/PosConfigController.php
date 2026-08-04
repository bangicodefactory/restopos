<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\DeviceType;
use App\Http\Controllers\Controller;
use App\Http\Requests\Device\CreatePairingCodeRequest;
use App\Models\Catalog\PosCategory;
use App\Models\Identity\Employee;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PosPrinter;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Services\Device\DevicePairingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
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
    public function __construct(private readonly DevicePairingService $pairing) {}

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
            ],
            'options' => Inertia::defer(fn (): array => [
                'payment_methods' => PaymentMethod::query()->orderBy('sequence')->get(['id', 'name', 'method_type', 'is_cash_count'])->all(),
                'pricelists' => Pricelist::query()->orderBy('name')->get(['id', 'name', 'currency_id'])->all(),
                'fiscal_positions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),
                'presets' => PosPreset::query()->orderBy('sequence')->get(['id', 'name', 'service_at'])->all(),
                'printers' => PosPrinter::query()->orderBy('name')->get(['id', 'name', 'printer_type'])->all(),
                'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all(),
                'employees' => Employee::query()->where('active', true)->orderBy('name')->get(['id', 'name', 'default_role'])->all(),
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
        ];

        foreach ($pivots as $key => $relation) {
            if (array_key_exists($key, $data)) {
                $config->{$relation}()->sync(array_map(intval(...), (array) $data[$key]));
                unset($data[$key]);
            }
        }

        $config->forceFill($data)->save();

        // Every client-visible edit invalidates every register's cache.
        $config->bumpRevision();

        return back()->with('success', 'Register settings saved.');
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
}
