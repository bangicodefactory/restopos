<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\MediaUpload;

use App\Models\Catalog\Product;
use App\Models\Identity\MediaFile;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The write half of the media pipeline (BAN-393).
 *
 * The read half shipped with BAN-480 and nothing could ever put a file there: no upload route
 * anywhere in the application, no `$request->file()` call in `app/`, and the only code that had ever
 * created a `media_files` row was the accounting exporter writing a generated CSV. Every picker in
 * the back office was a `Notice` explaining why it was not a picker.
 */
beforeEach(function (): void {
    Storage::fake('local');
    Storage::fake('public');

    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_media', 'catalog.view', 'catalog.manage_products'));
});

function upload(?UploadedFile $file = null, string $collection = 'image'): TestResponse
{
    return test()->postJson('/media', [
        'file' => $file ?? UploadedFile::fake()->image('logo.png', 120, 60),
        'collection' => $collection,
    ]);
}

it('stores an uploaded image and hands back its id', function (): void {
    // JSON rather than a redirect on purpose: the editor needs the *id* so it can put it in the
    // field it is editing, and a redirect hands back a page, not a value.
    $response = upload()->assertCreated();

    $id = $response->json('id');

    expect($id)->toBeInt()
        ->and(MediaFile::query()->whereKey($id)->exists())->toBeTrue()
        ->and($response->json('url'))->toContain((string) $id);
});

it('records the dimensions, size and checksum, not just the bytes', function (): void {
    $id = upload(UploadedFile::fake()->image('wide.png', 200, 50))->json('id');

    $media = MediaFile::query()->whereKey($id)->first();

    expect((int) $media->width)->toBe(200)
        ->and((int) $media->height)->toBe(50)
        ->and((int) $media->size_bytes)->toBeGreaterThan(0)
        ->and(strlen((string) $media->checksum))->toBe(64);
});

it('names the stored file after its checksum, never after what the browser sent', function (): void {
    // A filename arrives from a browser and is the client's to choose: `../../.env`, 300
    // characters, or a name differing from another only by case on a case-insensitive disk.
    $id = upload(UploadedFile::fake()->image('../../evil name.png', 10, 10))->json('id');

    $media = MediaFile::query()->whereKey($id)->first();

    expect((string) $media->path)->not->toContain('..')
        ->and((string) $media->path)->toContain((string) $media->checksum)
        ->and(Storage::disk('local')->exists((string) $media->path))->toBeTrue();
});

it('keeps the original filename as display text', function (): void {
    // It is shown to an operator so they can tell two logos apart; it is never joined into a path.
    $id = upload(UploadedFile::fake()->image('Logo Final v3.png', 10, 10))->json('id');

    expect((string) MediaFile::query()->whereKey($id)->value('filename'))->toBe('Logo Final v3.png');
});

it('stores one row when the same file is uploaded twice', function (): void {
    // The same logo set on five registers is one file on disk. Deduplicated by content hash.
    $first = upload(UploadedFile::fake()->image('a.png', 40, 40))->json('id');
    $before = MediaFile::query()->count();

    $second = upload(UploadedFile::fake()->image('a.png', 40, 40))->json('id');

    expect($second)->toBe($first)
        ->and(MediaFile::query()->count())->toBe($before);
});

it('refuses an SVG, which is a document and not a picture', function (): void {
    // An SVG can carry `<script>`, and `show()` streams these back inline from the application's
    // own origin. Allowing it means any operator who can upload a logo can run script in every
    // other operator's session.
    //
    // Written to disk for the same reason as the test below: the fake would answer from the name.
    $path = tempnam(sys_get_temp_dir(), 'logo').'.svg';
    file_put_contents($path, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    upload(new UploadedFile($path, 'logo.svg', null, null, true))->assertStatus(422);

    @unlink($path);
});

it('refuses a file that is not the image its name claims', function (): void {
    // `mimetypes:` sniffs the bytes; `mimes:` would have trusted the extension.
    //
    // A real file on disk, not `UploadedFile::fake()->createWithContent()`. That helper reports its
    // mime from the *name* — probed: an HTML document called `photo.png` answers `image/png` to
    // `getMimeType()` — so a test built on it would have been testing the helper and passing no
    // matter what the rule said.
    $path = tempnam(sys_get_temp_dir(), 'notimage').'.png';
    file_put_contents($path, '<!doctype html><script>alert(1)</script>');

    $disguised = new UploadedFile($path, 'photo.png', null, null, true);

    upload($disguised)->assertStatus(422);

    @unlink($path);
});

it('refuses an upload from someone without the ability', function (): void {
    // An upload endpoint is disk a stranger can fill, which is why it is its own grantable ability
    // rather than riding along with catalogue or configuration rights.
    $this->actingAs($this->fx->userWith('backoffice.access'));

    upload()->assertForbidden();
});

it('serves the file back to a signed-in operator', function (): void {
    // The only other serve route is device-authenticated, so a manager holding no device token
    // could not display the image they had just uploaded — the picker would show a broken preview.
    $id = upload()->json('id');

    $this->get("/media/{$id}")
        ->assertOk()
        ->assertHeader('X-Content-Type-Options', 'nosniff');
});

it('does not serve another venue media', function (): void {
    $id = upload()->json('id');

    $this->actingAs($this->other->userWith('backoffice.access', 'backoffice.manage_media'));

    $this->get("/media/{$id}")->assertNotFound();
});

it('lets a product carry an image now that one can exist', function (): void {
    // ProductController::validated explicitly excluded `image_media_id` because there was no
    // pipeline. There is one now.
    $id = upload()->json('id');
    $product = $this->fx->product;

    $this->patch("/products/{$product->uuid}", ['image_media_id' => $id])
        ->assertSessionHasNoErrors();

    expect((int) Product::query()->whereKey($product->getKey())->value('image_media_id'))->toBe($id);
});

it('refuses another venue image on a product', function (): void {
    $id = upload()->json('id');

    // Same upload, but attached from the other venue's side.
    $this->actingAs($this->other->userWith('backoffice.access', 'catalog.view', 'catalog.manage_products'));

    $theirProduct = $this->other->product;

    $this->patch("/products/{$theirProduct->uuid}", ['image_media_id' => $id])
        ->assertSessionHasErrors('image_media_id');

    expect(Product::query()->whereKey($theirProduct->getKey())->value('image_media_id'))->toBeNull();
});

it('lets a register carry a receipt logo, which the till already knew how to print', function (): void {
    // `receipt.ts` has built its blob key as `logo:{receipt_logo_media_id}` since it was written and
    // `build.ts` emits the image node — the column simply could never be set, so every receipt
    // printed without a logo.
    $id = upload(null, 'receipt_logo')->json('id');

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs', 'backoffice.manage_media'));

    $this->patch("/pos-configs/{$this->fx->config->uuid}", ['receipt_logo_media_id' => $id])
        ->assertSessionHasNoErrors();

    expect((int) $this->fx->config->fresh()->receipt_logo_media_id)->toBe($id);
});

it('puts a kiosk-facing image on the public disk and a receipt logo on the private one', function (): void {
    // Only what an anonymous kiosk visitor renders is public. A receipt logo is not.
    $brand = upload(null, 'brand')->json('id');
    $logo = upload(null, 'receipt_logo')->json('id');

    expect((string) MediaFile::query()->whereKey($brand)->value('disk'))->toBe('public')
        ->and((bool) MediaFile::query()->whereKey($brand)->value('is_public'))->toBeTrue()
        ->and((string) MediaFile::query()->whereKey($logo)->value('disk'))->toBe('local')
        ->and((bool) MediaFile::query()->whereKey($logo)->value('is_public'))->toBeFalse();
});
