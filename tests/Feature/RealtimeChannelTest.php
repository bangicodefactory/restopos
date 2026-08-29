<?php

declare(strict_types=1);

use App\Enums\DeviceType;
use App\Enums\OrderState;
use App\Events\Kitchen\KitchenTicketCreated;
use App\Events\Pos\OrderStateChanged;
use App\Events\Pos\OrderSynced;
use App\Events\Pos\SessionClosed;
use App\Events\Restaurant\TableStateChanged;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use App\Services\Pos\SessionService;
use Illuminate\Broadcasting\Broadcasters\Broadcaster;
use Illuminate\Contracts\Broadcasting\Factory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withSession()->withFloor();
});

it('authorises the broadcasting endpoint with a device bearer token, not a session', function (): void {
    // No token at all: the endpoint must not fall through to the web guard.
    $this->postJson('/broadcasting/auth', ['channel_name' => 'private-pos.config.'.$this->fx->config->access_token])
        ->assertStatus(401);
});

it('broadcasts order.synced and order.state on the config channel', function (): void {
    Event::fake([OrderSynced::class, OrderStateChanged::class]);

    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/sync', ['orders' => [$this->fx->orderCommand($uuid, [], ['state' => OrderState::Paid->value])]])
        ->assertOk();

    Event::assertDispatched(OrderSynced::class, function (OrderSynced $e) use ($uuid): bool {
        return $e->orderUuid === $uuid
            && $e->configToken === $this->fx->config->access_token
            && $e->emittedByDeviceUuid === $this->fx->device->uuid
            && $e->broadcastAs() === 'order.synced'
            && $e->broadcastOn()[0]->name === 'private-pos.config.'.$this->fx->config->access_token;
    });

    Event::assertDispatched(OrderStateChanged::class, function (OrderStateChanged $e): bool {
        // The customer-facing capability channel is public by design: the
        // channel name *is* the secret.
        return $e->broadcastOn()[1]->name === 'pos.order.'.$e->orderAccessToken;
    });
});

it('broadcasts table.state on both the config and the table channel', function (): void {
    Event::fake([TableStateChanged::class]);

    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/transfer", ['table_id' => $this->fx->tableTwo->getKey()])
        ->assertOk();

    Event::assertDispatched(TableStateChanged::class, function (TableStateChanged $e): bool {
        $channels = array_map(static fn ($c): string => $c->name, $e->broadcastOn());

        return in_array('private-pos.config.'.$this->fx->config->access_token, $channels, true)
            && in_array('private-pos.table.'.$e->tableId, $channels, true);
    });
});

/*
|--------------------------------------------------------------------------
| Provenance (BAN-402)
|--------------------------------------------------------------------------
|
| `OrderSynced` and `OrderStateChanged` have always carried the emitting
| device. `SessionClosed` and `TableStateChanged` were dispatched with the
| argument simply omitted, so they defaulted to null on the wire — and a
| subscriber cannot suppress its own echo against a field that is always null.
| It could only choose between re-pulling its own writes and hearing nothing.
|
*/

it('stamps the moving till on table.state so a peer can tell it from its own echo', function (): void {
    Event::fake([TableStateChanged::class]);

    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/orders/{$uuid}/transfer", ['table_id' => $this->fx->tableTwo->getKey()])
        ->assertOk();

    Event::assertDispatched(TableStateChanged::class, function (TableStateChanged $e): bool {
        return $e->emittedByDeviceUuid === $this->fx->device->uuid;
    });

    // …and on the wire, which is the only thing the register ever sees.
    Event::assertDispatched(TableStateChanged::class, function (TableStateChanged $e): bool {
        return $e->broadcastWith()['emitted_by_device_uuid'] === $this->fx->device->uuid;
    });
});

it('stamps the guest-count change too, not only the transfer', function (): void {
    Event::fake([TableStateChanged::class]);

    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    Event::fake([TableStateChanged::class]);

    $this->withHeaders($this->fx->headers())
        ->patchJson("/api/pos/orders/{$uuid}/guests", ['guest_count' => 4])
        ->assertOk();

    Event::assertDispatched(TableStateChanged::class, function (TableStateChanged $e): bool {
        return $e->emittedByDeviceUuid === $this->fx->device->uuid;
    });
});

it('stamps the closing till on session.closed', function (): void {
    Event::fake([SessionClosed::class]);

    $id = $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0'])
        ->assertOk();

    Event::assertDispatched(SessionClosed::class, function (SessionClosed $e): bool {
        return $e->emittedByDeviceUuid === $this->fx->device->uuid
            && $e->broadcastWith()['emitted_by_device_uuid'] === $this->fx->device->uuid;
    });
});

it('leaves session.closed unattributed when no device closed it', function (): void {
    // A back-office force-close. Null is the honest answer, and it matters: a subscriber that read
    // null as "mine" would ignore the close and keep trading into frozen summaries.
    Event::fake([SessionClosed::class]);

    app(SessionService::class)->close(
        session: $this->fx->session,
        countedCash: '0',
        managerApproved: true,
        force: true,
        abandon: true,
    );

    Event::assertDispatched(SessionClosed::class, function (SessionClosed $e): bool {
        return $e->emittedByDeviceUuid === null
            && $e->broadcastWith()['emitted_by_device_uuid'] === null;
    });
});

it('broadcasts a fat kitchen ticket on the display channel', function (): void {
    $this->fx->withPrepDisplay();

    Event::fake([KitchenTicketCreated::class]);

    $uuid = (string) Str::uuid();

    $this->withHeaders($this->fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$this->fx->orderCommand($uuid, [], ['table_id' => $this->fx->tableOne->getKey()])],
    ])->assertOk();

    $this->withHeaders($this->fx->headers())->postJson("/api/pos/orders/{$uuid}/preparation")->assertOk();

    Event::assertDispatched(KitchenTicketCreated::class, function (KitchenTicketCreated $e) use ($uuid): bool {
        return $e->displayToken === $this->fx->display->access_token
            && $e->ticket['order_uuid'] === $uuid
            && $e->ticket['lines'] !== []
            && $e->broadcastAs() === 'kitchen.ticket.created';
    });
});

it('broadcasts session.closed on the config and session channels', function (): void {
    Event::fake([SessionClosed::class]);

    $id = $this->fx->session->getKey();

    $this->withHeaders($this->fx->headers())
        ->postJson("/api/pos/sessions/{$id}/close", ['counted_cash' => '0'])
        ->assertOk();

    Event::assertDispatched(SessionClosed::class, function (SessionClosed $e) use ($id): bool {
        $channels = array_map(static fn ($c): string => $c->name, $e->broadcastOn());

        return $e->sessionId === $id
            && in_array('private-pos.session.'.$id, $channels, true);
    });
});

it('authorises a config channel only for a device of that config', function (): void {
    $other = PosFixtures::make();

    $mine = $this->fx->config->access_token;
    $theirs = $other->config->access_token;

    expect(channelAuthorises($this->fx->device, 'pos.config.'.$mine))->toBeTrue()
        ->and(channelAuthorises($this->fx->device, 'pos.config.'.$theirs))->toBeFalse();
});

it('authorises a device channel only for the device itself', function (): void {
    $second = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'device_identifier' => 7,
        'name' => 'Second till',
        'device_type' => DeviceType::Register->value,
        'active' => true,
    ]);

    app(DeviceTokenService::class)->issue($second);

    expect(channelAuthorises($this->fx->device, 'pos.device.'.$this->fx->device->uuid))->toBeTrue()
        ->and(channelAuthorises($this->fx->device, 'pos.device.'.$second->uuid))->toBeFalse();
});

it('refuses every private channel to a revoked device', function (): void {
    $this->fx->device->forceFill(['active' => false])->save();

    expect(channelAuthorises($this->fx->device, 'pos.config.'.$this->fx->config->access_token))->toBeFalse();
});

/** Resolve a channel authorization callback the way the broadcaster does. */
function channelAuthorises(PosDevice $device, string $channel): bool
{
    /** @var Broadcaster $broadcaster */
    $broadcaster = app(Factory::class)->connection();

    $reflection = new ReflectionClass($broadcaster);
    $property = $reflection->getProperty('channels');
    $property->setAccessible(true);

    /** @var array<string, callable> $channels */
    $channels = $property->getValue($broadcaster);

    foreach ($channels as $pattern => $callback) {
        $regex = '/^'.preg_replace('/\\\{(.*?)\\\}/', '(?<$1>[^\.]+)', preg_quote($pattern, '/')).'$/u';

        if (preg_match($regex, $channel, $matches) === 1) {
            $parameters = array_values(array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY));

            return (bool) $callback($device, ...$parameters);
        }
    }

    return false;
}
