<?php

declare(strict_types=1);

use App\Enums\MediaCollection;
use App\Models\Identity\MediaFile;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BAN-480 / SLF-024 — the media read path.
 *
 * `media_files` had ~10 foreign keys pointing at it and no code on either side, so every product
 * tile rendered a placeholder and every receipt printed without a logo. These cover the half this
 * ticket owns: the metadata shipping with the catalogue, and the bytes being fetchable by a device
 * that is allowed to read the catalogue — and by nobody else.
 */
beforeEach(function (): void {
    Storage::fake('public');

    $this->fx = PosFixtures::make()->withSession();
});

function media(PosFixtures $fx, string $collection = 'image', array $overrides = []): MediaFile
{
    Storage::disk('public')->put('media/tile.png', 'PNG-BYTES');

    return MediaFile::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'collection' => $collection,
        'disk' => 'public',
        'path' => 'media/tile.png',
        'filename' => 'tile.png',
        'mime_type' => 'image/png',
        'size_bytes' => 9,
        'checksum' => 'abc123',
        'is_public' => true,
        ...$overrides,
    ]);
}

it('ships media metadata with the catalogue, and never the path', function (): void {
    $file = media($this->fx);

    $payload = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json();

    $rows = $payload['data']['media_files'] ?? null;

    expect($rows)->not->toBeNull('media_files must ship in the bootstrap payload')
        ->and($rows)->toHaveCount(1)
        ->and($rows[0]['id'])->toBe($file->getKey())
        ->and($rows[0]['mime_type'])->toBe('image/png');

    // The storage path must not travel. A client that knew it could try to reach the object
    // directly and bypass this route's authorization entirely.
    expect($rows[0])->not->toHaveKey('path')
        ->and($rows[0])->not->toHaveKey('disk');
});

it('serves the bytes to a device that may read the catalogue', function (): void {
    $file = media($this->fx);

    $response = $this->withHeaders($this->fx->headers())->get('/api/pos/media/'.$file->getKey());

    $response->assertOk()
        ->assertHeader('Content-Type', 'image/png')
        ->assertHeader('ETag', '"abc123"');

    // Immutable: an edit uploads a new row rather than rewriting bytes, so the client and the
    // service worker can both hold this indefinitely. Asserted by directive rather than by the
    // literal header — Laravel reorders them.
    $cacheControl = $response->headers->get('Cache-Control');

    expect($cacheControl)->toContain('immutable')
        ->and($cacheControl)->toContain('max-age=31536000')
        ->and($cacheControl)->toContain('private');

    expect($response->streamedContent())->toBe('PNG-BYTES');
});

it('refuses a device without the catalogue ability', function (): void {
    // The acceptance criterion, directly: a device that cannot read the menu cannot read its
    // pictures either.
    $file = media($this->fx);

    $this->withHeaders(['Accept' => 'application/json'])
        ->get('/api/pos/media/'.$file->getKey())
        ->assertUnauthorized();
});

it('refuses another company media', function (): void {
    $stranger = PosFixtures::make()->withSession();
    $theirs = media($stranger);

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/media/'.$theirs->getKey())
        ->assertNotFound();
});

it('refuses a collection no POS surface renders', function (): void {
    // A scanned invoice has no business being reachable from a device on the counter, even though
    // it belongs to the same company.
    $document = media($this->fx, MediaCollection::Document->value);

    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/media/'.$document->getKey())
        ->assertNotFound();

    // …and it does not ship in the catalogue either.
    $rows = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()
        ->json('data.media_files');

    expect($rows)->toBe([]);
});

it('404s when the row exists but the file is gone', function (): void {
    $file = media($this->fx);
    Storage::disk('public')->delete('media/tile.png');

    // A dangling row is a 404, not a 500: the client's fallback is the placeholder it already draws.
    $this->withHeaders($this->fx->headers())
        ->getJson('/api/pos/media/'.$file->getKey())
        ->assertNotFound();
});

it('gives the kiosk public URLs, because a phone holds no credential', function (): void {
    // The register fetches media through an authenticated route. A customer's phone cannot: it has
    // a public token, not a device token. So the kiosk menu carries public URLs instead — which is
    // what `media_files.is_public` is for, and what the kiosk's `imageUrls` map has always read.
    $product = $this->fx->product;

    $public = media($this->fx, MediaCollection::Image->value, [
        'model_type' => $product::class,
        'model_id' => $product->getKey(),
        'is_public' => true,
    ]);

    media($this->fx, MediaCollection::Image->value, ['is_public' => false]);

    $this->fx->config->forceFill(['self_ordering_mode' => 'mobile'])->save();

    $menu = $this->getJson('/api/self-order/'.$this->fx->config->access_token.'/menu')
        ->assertOk()
        ->json('data.media_files');

    expect($menu)->toHaveCount(1)
        ->and($menu[0]['id'])->toBe($public->getKey())
        // Keyed `product:{id}` on the client, so the model name has to arrive snake-cased.
        ->and($menu[0]['model'])->toBe('product')
        ->and($menu[0]['model_id'])->toBe($product->getKey())
        ->and($menu[0]['url'])->toBeString();
});

it('ships the receipt logo so the printer can find it', function (): void {
    $logo = media($this->fx, MediaCollection::ReceiptLogo->value);

    $this->fx->config->forceFill(['receipt_logo_media_id' => $logo->getKey()])->save();

    $payload = $this->withHeaders($this->fx->headers())->getJson('/api/pos/bootstrap')->assertOk()->json();

    // The client turns this id into the blob key `logo:{id}`, which is what `receipt.ts` already
    // builds and what `quota.ts` already refuses to evict.
    expect(collect($payload['data']['media_files'])->pluck('id'))->toContain($logo->getKey());

    $config = collect($payload['data']['pos_configs'] ?? [])->firstWhere('id', $this->fx->config->getKey());

    expect($config['receipt_logo_media_id'] ?? null)->toBe($logo->getKey());
});
