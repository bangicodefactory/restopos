<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DevicePairingService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Devices/Index` (spec 03 §2.2).
 *
 * Revoking a device kills its tokens immediately, but an *offline* revoked till
 * keeps working until it reconnects — that is unavoidable and correct: a till
 * mid-shift must not brick itself. The compensating control is that its queued
 * orders arrive as quarantined rather than being lost.
 */
final class DeviceController extends Controller
{
    public function __construct(private readonly DevicePairingService $pairing) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', PosDevice::class);

        return Inertia::render('Devices/Index', [
            // Scoped through the register, because `pos_devices` has no `company_id` of its own
            // and therefore no global scope. Unscoped, this listed every tenant's devices —
            // their names, user agents and last-seen times.
            'devices' => PosDevice::query()
                ->whereIn('pos_config_id', PosConfig::query()->select('id'))
                ->with('posConfig:id,name')->orderBy('pos_config_id')->orderBy('device_identifier')->get()
                ->map(static fn (PosDevice $d): array => [
                    'id' => (int) $d->getKey(),
                    'uuid' => (string) $d->uuid,
                    'name' => $d->name,
                    'device_identifier' => (int) $d->device_identifier,
                    'device_type' => $d->device_type->value,
                    'pos_config_id' => (int) $d->pos_config_id,
                    'pos_config_name' => $d->posConfig?->name,
                    'last_seen_at' => $d->last_seen_at,
                    'last_synced_at' => $d->last_synced_at,
                    'user_agent' => $d->user_agent,
                    'active' => (bool) $d->active,
                ])->values()->all(),
            'configs' => PosConfig::query()->where('active', true)->orderBy('name')->get(['id', 'uuid', 'name'])->all(),
        ]);
    }

    public function destroy(PosDevice $device): RedirectResponse
    {
        // Revoking someone else's device bricks their till mid-service.
        Gate::authorize('delete', $device);

        $this->pairing->revoke($device);

        return back()->with('success', 'Device revoked. It will wipe its local data on next connection.');
    }
}
