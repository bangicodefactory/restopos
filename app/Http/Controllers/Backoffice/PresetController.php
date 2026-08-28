<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Backoffice\PresetRequest;
use App\Http\Requests\Backoffice\ServiceWindowRequest;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PresetServiceWindow;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\Pricelist;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Service modes and their opening hours (BOF-113, BAN-429).
 *
 * A preset is how a venue distinguishes eat-in from takeaway from delivery. It carries the price
 * list that applies, the fiscal position that rewrites the tax, what the customer must identify
 * themselves with, and — when `use_timing` is on — the hours it takes bookings and how many it takes
 * at once.
 *
 * All of that existed as columns and as seeded rows. **None of it could be created.** No route, no
 * controller, no page: a venue adding delivery had to reach for SQL, and the register would then
 * have shown it correctly, because every runtime consumer was already in place.
 *
 * ## The system presets
 *
 * `is_system` marks the modes the product ships with. They can be renamed and re-priced like any
 * other, but not removed: `PosConfig` and the self-order surface both fall back to them, and a venue
 * that deleted "Eat in" would have a register with no default mode and no way back through the UI.
 */
final class PresetController extends Controller
{
    public function index(): Response
    {
        Gate::authorize('viewAny', PosPreset::class);

        return Inertia::render('Presets/Index', [
            'presets' => PosPreset::query()
                ->withCount('serviceWindows')
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(static fn (PosPreset $p): array => [
                    'id' => (int) $p->getKey(),
                    'name' => (string) $p->name,
                    'identification' => $p->identification->value,
                    'service_at' => $p->service_at->value,
                    'pricelist_id' => $p->pricelist_id,
                    'fiscal_position_id' => $p->fiscal_position_id,
                    'use_timing' => (bool) $p->use_timing,
                    'slots_per_interval' => (int) $p->slots_per_interval,
                    'interval_minutes' => (int) $p->interval_minutes,
                    'available_in_self' => (bool) $p->available_in_self,
                    'is_system' => (bool) $p->is_system,
                    'sequence' => (int) $p->sequence,
                    'active' => (bool) $p->active,
                    'window_count' => (int) $p->service_windows_count,
                ])->values()->all(),
            // What a preset can be pointed at. Both are company-owned, so both arrive already scoped.
            'pricelists' => Pricelist::query()->where('active', true)->orderBy('name')
                ->get(['id', 'name'])->all(),
            'fiscalPositions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),
        ]);
    }

    public function edit(PosPreset $preset): Response
    {
        Gate::authorize('view', $preset);

        return Inertia::render('Presets/Edit', [
            'preset' => $preset->attributesToArray(),
            'windows' => $preset->serviceWindows()
                ->orderBy('day_of_week')
                ->orderBy('hour_from')
                ->get()
                ->map(static fn (PresetServiceWindow $w): array => $w->attributesToArray())
                ->values()
                ->all(),
            'pricelists' => Pricelist::query()->where('active', true)->orderBy('name')
                ->get(['id', 'name'])->all(),
            'fiscalPositions' => FiscalPosition::query()->orderBy('name')->get(['id', 'name'])->all(),
        ]);
    }

    public function store(PresetRequest $request): RedirectResponse
    {
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a service mode.',
            ]);
        }

        $preset = PosPreset::query()->create([
            ...$request->validated(),
            'company_id' => $companyId,
            // Only the seeder mints system presets. A mode created here is the venue's own and stays
            // removable, whatever the request said.
            'is_system' => false,
        ]);

        return redirect()
            ->route('presets.edit', $preset->getKey())
            ->with('success', 'Service mode added. Its opening hours are below.');
    }

    public function update(PresetRequest $request, PosPreset $preset): RedirectResponse
    {
        $data = $request->validated();

        $this->assertStillUsableAsADefault($preset, $data);

        $preset->forceFill($data)->save();

        return back()->with('success', 'Service mode saved.');
    }

    /**
     * Refused while anything still points at it.
     *
     * A past order names the mode it was taken under, and that is how a venue answers "how much of
     * last month was delivery" — removing the mode would erase the answer, not just the row.
     */
    public function destroy(PosPreset $preset): RedirectResponse
    {
        Gate::authorize('delete', $preset);

        if ($preset->is_system) {
            throw ValidationException::withMessages([
                'preset' => 'This is one of the modes the product ships with and cannot be removed.'
                    .' Deactivate it instead — it stops being offered and every register keeps a mode'
                    .' to fall back on.',
            ]);
        }

        $orders = Order::query()->where('pos_preset_id', $preset->getKey())->count();

        if ($orders > 0) {
            throw ValidationException::withMessages([
                'preset' => 'This mode was used on '.$orders.' order(s) and cannot be removed.'
                    .' Deactivate it instead — every past order keeps saying how it was taken.',
            ]);
        }

        $defaults = PosConfig::query()->where('default_preset_id', $preset->getKey())->count();

        if ($defaults > 0) {
            throw ValidationException::withMessages([
                'preset' => 'This mode is the default on '.$defaults.' register(s). Point them at'
                    .' another one first, or they would open with no mode at all.',
            ]);
        }

        $preset->delete();

        return back()->with('success', 'Service mode removed.');
    }

    public function storeWindow(ServiceWindowRequest $request, PosPreset $preset): RedirectResponse
    {
        $preset->serviceWindows()->create($request->validated());

        return back()->with('success', 'Opening hours added.');
    }

    public function updateWindow(ServiceWindowRequest $request, PosPreset $preset, PresetServiceWindow $window): RedirectResponse
    {
        $this->refuseForeignWindow($preset, $window);

        $window->forceFill($request->validated())->save();

        return back()->with('success', 'Opening hours saved.');
    }

    public function destroyWindow(PosPreset $preset, PresetServiceWindow $window): RedirectResponse
    {
        Gate::authorize('update', $preset);
        $this->refuseForeignWindow($preset, $window);

        $window->delete();

        return back()->with('success', 'Opening hours removed.');
    }

    /**
     * A register's default mode has to remain one the register can offer.
     *
     * `PosConfigRequest` already refuses attaching a preset that is not this company's, and BOF-032
     * auto-adds the default to the available list. Neither covers this direction: deactivating a
     * mode that a register defaults to leaves that register opening on a mode it will not show, and
     * the till falls back to no mode at all — which on a delivery-only register means every order
     * arrives with no service type.
     *
     * @param  array<string, mixed>  $data
     */
    private function assertStillUsableAsADefault(PosPreset $preset, array $data): void
    {
        if (! array_key_exists('active', $data) || (bool) $data['active'] === true) {
            return;
        }

        if ((bool) $preset->active === false) {
            return;
        }

        $defaults = PosConfig::query()->where('default_preset_id', $preset->getKey())->count();

        if ($defaults > 0) {
            throw ValidationException::withMessages([
                'active' => $defaults.' register(s) open on this mode. Point them at another default'
                    .' first — otherwise they would open with no service mode and every order would'
                    .' arrive without one.',
            ]);
        }
    }

    private function refuseForeignWindow(PosPreset $preset, PresetServiceWindow $window): void
    {
        abort_unless((int) $window->pos_preset_id === (int) $preset->getKey(), 404);
    }
}
