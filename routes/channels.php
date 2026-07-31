<?php

declare(strict_types=1);

use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosSession;
use App\Models\Restaurant\Table as RestaurantTable;
use Illuminate\Support\Facades\Broadcast;
use Laravel\Sanctum\PersonalAccessToken;

/*
|--------------------------------------------------------------------------
| Broadcast channel authorization (spec 03 §5.2, §5.3)
|--------------------------------------------------------------------------
|
| The authenticated principal on `/broadcasting/auth` is a **PosDevice**, not a
| User: registers, kitchen displays and kiosks hold Sanctum bearer tokens, and
| `AuthenticateDevice` binds the device as the request user.
|
| Channel naming is capability-shaped:
|
|   private-pos.config.{configToken}     registers + displays of one register
|   private-pos.session.{sessionId}      session lifecycle
|   private-pos.device.{deviceUuid}      targeted commands (revoke, reload, print)
|   private-pos.table.{tableId}          floor-plan occupancy
|   private-kitchen.display.{token}      one KDS screen
|   pos.self.{configToken}     (public)  menu / availability for anonymous clients
|   pos.order.{orderToken}     (public)  one customer's own order
|
| The two public channels are deliberate: the channel *name is the capability*.
| Knowing `pos.order.{token}` is knowing the secret, which is exactly the
| property we want for an anonymous customer with no account. Nothing sensitive
| — costs, margins, other orders — is ever emitted on them.
|
*/

/** The config a device is bound to, matched by the config's access token. */
Broadcast::channel('pos.config.{configToken}', function (mixed $device, string $configToken): bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    return PosConfig::query()
        ->whereKey($device->pos_config_id)
        ->where('access_token', $configToken)
        ->exists();
});

/** Presence variant — drives "3 terminals connected" and the multi-tab guard. */
Broadcast::channel('pos.config.{configToken}.devices', function (mixed $device, string $configToken): array|bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    $matches = PosConfig::query()
        ->whereKey($device->pos_config_id)
        ->where('access_token', $configToken)
        ->exists();

    return $matches ? [
        'id' => (int) $device->getKey(),
        'uuid' => (string) $device->uuid,
        'name' => $device->name,
        'kind' => $device->device_type->value,
    ] : false;
});

Broadcast::channel('pos.session.{sessionId}', function (mixed $device, string $sessionId): bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    return PosSession::query()
        ->whereKey((int) $sessionId)
        ->where('pos_config_id', $device->pos_config_id)
        ->exists();
});

/** A device may only listen to commands addressed to itself. */
Broadcast::channel('pos.device.{deviceUuid}', function (mixed $device, string $deviceUuid): bool {
    return $device instanceof PosDevice
        && $device->active
        && hash_equals((string) $device->uuid, $deviceUuid);
});

Broadcast::channel('pos.table.{tableId}', function (mixed $device, string $tableId): bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    return RestaurantTable::query()
        ->whereKey((int) $tableId)
        ->whereHas('floor.posConfigs', fn ($q) => $q->whereKey($device->pos_config_id))
        ->exists();
});

/**
 * A kitchen display: the token names the screen, and the screen must be wired to
 * the device's config. A `pos:kitchen` ability is required, so a register token
 * cannot silently subscribe to a kitchen feed.
 */
Broadcast::channel('kitchen.display.{displayToken}', function (mixed $device, string $displayToken): bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    $token = $device->currentAccessToken ?? null;

    if ($token instanceof PersonalAccessToken && ! $token->can('pos:kitchen')) {
        return false;
    }

    return PrepDisplay::query()
        ->where('access_token', $displayToken)
        ->whereHas('posConfigs', fn ($q) => $q->whereKey($device->pos_config_id))
        ->exists();
});

/*
| The public channels below need no authorization callback — Laravel does not
| call one for non-private channels. They are documented here so the catalogue
| is complete and reviewable in one place:
|
|   pos.self.{configToken}   catalog.changed, product.availability,
|                            selforder.config.status
|   pos.order.{orderToken}   order.state, payment.status, selforder.placed
|
| `configToken` is `pos_configs.access_token` and `orderToken` is
| `pos_orders.access_token`; both rotate independently.
*/

/**
 * Registered so an authenticated *device* can also follow a specific customer
 * order (the kiosk showing a live status screen), without granting anything the
 * public channel would not already give away.
 */
Broadcast::channel('pos.order-private.{orderToken}', function (mixed $device, string $orderToken): bool {
    if (! $device instanceof PosDevice || ! $device->active) {
        return false;
    }

    return Order::query()
        ->where('access_token', $orderToken)
        ->where('pos_config_id', $device->pos_config_id)
        ->exists();
});
