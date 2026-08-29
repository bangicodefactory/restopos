<?php

declare(strict_types=1);

use App\Enums\DeviceType;
use App\Enums\MediaCollection;
use App\Events\Pos\CustomerDisplayUpdated;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Services\Device\DeviceTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-443a — the customer display's server side (REG-352, REG-354, XCT-031).
 *
 * The display only ever worked on a second window of the same browser: `BroadcastChannel` and
 * nothing else. There was no display event in `app/Events/`, no channel, and no way for a screen
 * with no device token to read the background the back office had been able to configure since the
 * column landed.
 */
beforeEach(function (): void {
    Storage::fake('public');

    $this->fx = PosFixtures::make()->withSession();
});

function displayMedia(PosFixtures $fx, string $collection = MediaCollection::Brand->value): MediaFile
{
    Storage::disk('public')->put('media/wall.png', 'WALL-BYTES');

    return MediaFile::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'collection' => $collection,
        'disk' => 'public',
        'path' => 'media/wall.png',
        'filename' => 'wall.png',
        'mime_type' => 'image/png',
        'size_bytes' => 10,
        'checksum' => 'wall-sum',
        'is_public' => false,
    ]);
}

/** The frame the register relays — the same three kinds `DisplayPayload` declares on the client. */
function displayFrame(array $overrides = []): array
{
    return ['kind' => 'idle', 'venue' => 'Trattoria', 'at' => 1, ...$overrides];
}

// ── the token ───────────────────────────────────────────────────────────────

it('does not name the display channel with the self-order token', function (): void {
    $token = $this->fx->config->customerDisplayToken();

    // The whole reason this token exists. `access_token` is printed on every table's self-order QR,
    // so a channel named with it would let any guest in the room subscribe to every sale.
    expect($token)->not->toBe($this->fx->config->access_token)
        ->and($token)->not->toContain($this->fx->config->access_token)
        ->and($token)->toMatch('/^[0-9a-f]{40}$/');
});

it('gives two registers two different display channels', function (): void {
    $other = PosFixtures::make()->withSession();

    // Two ids under two access tokens. A derivation that ignored either would collapse the venues
    // onto one channel and put one venue's sales on the other's screen.
    expect($other->config->customerDisplayToken())->not->toBe($this->fx->config->customerDisplayToken());
});

it('rotates the display channel when the access token rotates', function (): void {
    $before = $this->fx->config->customerDisplayToken();

    $this->fx->config->forceFill(['access_token' => PosConfig::newAccessToken()])->save();

    // The reason it is derived rather than stored: a till whose token was rotated after a leak
    // must not keep broadcasting on the channel the leak named.
    expect($this->fx->config->fresh()?->customerDisplayToken())->not->toBe($before);
});

it('ships the display token to the register that has to hand it out', function (): void {
    $row = collect($this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()
        ->json('data.pos_configs'))
        ->firstWhere('id', $this->fx->config->getKey());

    // The register builds the pairing URL from this and relays onto the channel it names. A token
    // the client cannot see is a display nobody can pair.
    expect($row['customer_display_token'] ?? null)->toBe($this->fx->config->customerDisplayToken());
});

// ── the relay ───────────────────────────────────────────────────────────────

it('broadcasts a relayed frame on the display channel', function (): void {
    Event::fake([CustomerDisplayUpdated::class]);

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/customer-display', ['payload' => displayFrame(['kind' => 'order'])])
        ->assertStatus(202);

    Event::assertDispatched(CustomerDisplayUpdated::class, function (CustomerDisplayUpdated $e): bool {
        return $e->broadcastAs() === 'display.update'
            // Public: the display holds no credential, so the channel name *is* the capability —
            // the same property `pos.order.{orderToken}` relies on. A `PrivateChannel` here would
            // send Echo to `/broadcasting/auth`, which 401s without a bearer.
            && $e->broadcastOn()[0]->name === 'pos.display.'.$this->fx->config->customerDisplayToken()
            && $e->emittedByDeviceUuid === $this->fx->device->uuid
            // The rule this event deliberately breaks: the payload *is* the data. The display has
            // no replica to pull from, so a hint would name rows it cannot fetch.
            && $e->broadcastWith()['payload'] === displayFrame(['kind' => 'order']);
    });
});

it('scopes the channel to the relaying device own config', function (): void {
    Event::fake([CustomerDisplayUpdated::class]);

    $stranger = PosFixtures::make()->withSession();

    $this->withHeaders($stranger->headers())
        ->postJson('/api/pos/customer-display', ['payload' => displayFrame()])
        ->assertStatus(202);

    // Nothing in the request names a config. A till cannot drive another venue's screen because
    // there is no parameter with which to try.
    Event::assertDispatched(CustomerDisplayUpdated::class, function (CustomerDisplayUpdated $e) use ($stranger): bool {
        return $e->displayToken === $stranger->config->customerDisplayToken()
            && $e->displayToken !== $this->fx->config->customerDisplayToken();
    });
});

it('refuses a relay from a device with no token', function (): void {
    Event::fake([CustomerDisplayUpdated::class]);

    $this->withHeaders(['Accept' => 'application/json'])
        ->postJson('/api/pos/customer-display', ['payload' => displayFrame()])
        ->assertUnauthorized();

    Event::assertNotDispatched(CustomerDisplayUpdated::class);
});

it('refuses a relay from a device whose token does not carry pos:realtime', function (): void {
    Event::fake([CustomerDisplayUpdated::class]);

    // `config('pos.abilities')` gives `self_mobile` catalogue and self-order and nothing else. A
    // token that may read a menu must not be able to drive the screen at the counter — and a
    // no-token test alone would not have noticed the ability constraint being dropped, because
    // every device type a venue actually pairs happens to hold `pos:realtime`.
    $weak = PosDevice::query()->create([
        'uuid' => (string) Str::uuid(),
        'pos_config_id' => $this->fx->config->getKey(),
        'device_identifier' => 99,
        'name' => 'A phone',
        'device_type' => DeviceType::SelfMobile->value,
        'active' => true,
    ]);

    $token = app(DeviceTokenService::class)->issue($weak)['token'];

    expect($token)->toBeString();

    $this->withHeaders(['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json'])
        ->postJson('/api/pos/customer-display', ['payload' => displayFrame()])
        ->assertForbidden();

    Event::assertNotDispatched(CustomerDisplayUpdated::class);
});

it('refuses a frame the display could not render', function (): void {
    Event::fake([CustomerDisplayUpdated::class]);

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/customer-display', ['payload' => ['kind' => 'weight', 'at' => 1]])
        ->assertStatus(422);

    $this->withHeaders($this->fx->headers())
        ->postJson('/api/pos/customer-display', [])
        ->assertStatus(422);

    // A broadcast the screen cannot draw is worse than none: it is a white screen in front of a
    // customer, on a device with no replica to fall back to.
    Event::assertNotDispatched(CustomerDisplayUpdated::class);
});

// ── branding ────────────────────────────────────────────────────────────────

it('gives a display with no credential its venue name and background', function (): void {
    $media = displayMedia($this->fx);
    $this->fx->config->forceFill(['customer_display_bg_media_id' => $media->getKey()])->save();

    $id = $this->fx->config->getKey();
    $token = $this->fx->config->customerDisplayToken();

    $data = $this->getJson("/api/pos/customer-display/{$id}?token={$token}")->assertOk()->json('data');

    expect($data['venue'])->toBe($this->fx->company->name)
        ->and($data['channel'])->toBe('pos.display.'.$token)
        // A URL, not an id: the display cannot turn an id into bytes. It holds no bearer token, so
        // `/api/pos/media/{id}` — behind `device.can:pos:catalog` — is closed to it, and a CSS
        // `url()` cannot carry a header anyway.
        ->and($data['background'])->toContain("/api/pos/customer-display/{$id}/background");

    $bytes = $this->get($data['background']);

    $bytes->assertOk()->assertHeader('Content-Type', 'image/png');

    expect($bytes->streamedContent())->toBe('WALL-BYTES');
});

it('reports no background when the venue configured none', function (): void {
    $id = $this->fx->config->getKey();
    $token = $this->fx->config->customerDisplayToken();

    expect($this->getJson("/api/pos/customer-display/{$id}?token={$token}")->assertOk()->json('data.background'))
        ->toBeNull();

    $this->get("/api/pos/customer-display/{$id}/background?token={$token}")->assertNotFound();
});

it('refuses a wrong token, an absent one, and another config token', function (): void {
    $media = displayMedia($this->fx);
    $this->fx->config->forceFill(['customer_display_bg_media_id' => $media->getKey()])->save();

    $id = $this->fx->config->getKey();
    $stranger = PosFixtures::make()->withSession();

    // 404 rather than 403 throughout: an unknown token must not confirm the config exists.
    $this->getJson("/api/pos/customer-display/{$id}?token=nope")->assertNotFound();
    $this->getJson("/api/pos/customer-display/{$id}")->assertNotFound();
    $this->getJson("/api/pos/customer-display/{$id}?token=".$this->fx->config->access_token)->assertNotFound();
    $this->getJson("/api/pos/customer-display/{$id}?token=".$stranger->config->customerDisplayToken())
        ->assertNotFound();
    $this->get("/api/pos/customer-display/{$id}/background?token=nope")->assertNotFound();
});

it('refuses a background pointed at a collection no POS surface renders', function (): void {
    // The back office picks the id and nothing there stops a manager pointing the column at a
    // scanned invoice. A screen facing the dining room is the last place that should render one.
    $document = displayMedia($this->fx, MediaCollection::Document->value);
    $this->fx->config->forceFill(['customer_display_bg_media_id' => $document->getKey()])->save();

    $id = $this->fx->config->getKey();
    $token = $this->fx->config->customerDisplayToken();

    expect($this->getJson("/api/pos/customer-display/{$id}?token={$token}")->assertOk()->json('data.background'))
        ->toBeNull();

    $this->get("/api/pos/customer-display/{$id}/background?token={$token}")->assertNotFound();
});

it('404s when the row exists but the file is gone', function (): void {
    $media = displayMedia($this->fx);
    $this->fx->config->forceFill(['customer_display_bg_media_id' => $media->getKey()])->save();

    Storage::disk('public')->delete('media/wall.png');

    $id = $this->fx->config->getKey();
    $token = $this->fx->config->customerDisplayToken();

    // A dangling row is a 404, not a 500: the display's fallback is the plain dark shell it drew
    // before anyone configured a background.
    $this->get("/api/pos/customer-display/{$id}/background?token={$token}")->assertNotFound();
});
