<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DevicePairingService;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
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
                    'app_version' => $d->app_version,
                    'paired_at' => $d->paired_at,
                    // Only whether one is recorded, never the value. A fingerprint identifies a
                    // physical machine and is the thing a re-pair is matched on; showing it would
                    // put a value on screen that lets someone else's terminal claim this one's
                    // identity, its device_identifier and its history.
                    'has_fingerprint' => filled($d->hardware_fingerprint),
                    'active' => (bool) $d->active,
                ])->values()->all(),
            'configs' => PosConfig::query()->where('active', true)->orderBy('name')->get(['id', 'uuid', 'name'])->all(),
        ]);
    }

    /**
     * `PATCH /devices/{device}` — name it, or take it out of service (BAN-456).
     *
     * A device could be revoked and nothing else. "Which of these five is the bar till?" had no
     * answer beyond a number allocated in pairing order, and the only way to correct a mistake was
     * to revoke the device and re-pair it — which, on a terminal that is working fine, is a
     * service interruption to fix a label.
     *
     * Deactivating is the gentler alternative to revoking: the device stops being offered and its
     * tokens survive, so it can be brought back without a physical trip to re-pair it.
     */
    public function update(Request $request, PosDevice $device): RedirectResponse
    {
        Gate::authorize('update', $device);

        $data = $request->validate([
            'name' => ['sometimes', 'nullable', 'string', 'max:80'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $device->forceFill($data)->save();

        return back()->with('success', 'Device saved.');
    }

    public function destroy(PosDevice $device): RedirectResponse
    {
        // Revoking someone else's device bricks their till mid-service.
        Gate::authorize('delete', $device);

        $this->pairing->revoke($device);

        return back()->with('success', 'Device revoked. It will wipe its local data on next connection.');
    }
}
