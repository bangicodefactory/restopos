<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Models\Identity\MediaFile;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * `GET /api/pos/media/{media}` — the bytes behind a `*_media_id` (SLF-024, BAN-480).
 *
 * The database has had ~10 `*_media_id` foreign keys and no code on either side of them since the
 * schema landed, so every product tile rendered a placeholder and every receipt printed without a
 * logo. This is the read half; uploads are BAN-393.
 *
 * **Why the client fetches these rather than pointing an `<img>` at them.** A device authenticates
 * with a bearer token, and an `<img src>` cannot carry a header — so a plain `<img>` against this
 * route would be anonymous, which would mean either serving media unauthenticated or serving it not
 * at all. The clients instead `fetch()` with their token and keep the bytes in the Dexie blob store,
 * rendering from an object URL. That is not a workaround bolted on: `quota.ts` already evicts blobs
 * keyed `product:*` first and spares `logo:*`, because a product photo is disposable and a receipt
 * logo is not. The storage design was there waiting for a route to fill it.
 *
 * It also gets offline for free, which a signed URL would not: the bytes are in IndexedDB with the
 * rest of the replica rather than in an HTTP cache that a signature expiry can invalidate.
 */
final class MediaController extends Controller
{
    use ResolvesDeviceContext;

    public function show(Request $request, MediaFile $media): Response|StreamedResponse
    {
        [, $config] = $this->deviceContext($request);

        // Company first, then collection. The company check is the tenant boundary; the collection
        // check stops a till pulling `document` media — scanned invoices and the like — which no POS
        // surface renders and which has no business being reachable from a device on the counter.
        abort_unless((int) $media->company_id === (int) $config->company_id, 404);
        abort_unless(in_array($media->collection->value, MediaFile::posCollections(), true), 404);

        // `is_public` is deliberately not consulted. It marks what may be handed to an anonymous
        // caller — the kiosk's menu photos — and this caller is neither anonymous nor untrusted: it
        // is a paired device of this company holding a catalogue-scoped token. Requiring the flag
        // here would hide a venue's own product photos from its own till.

        $disk = Storage::disk($media->disk);

        abort_unless($disk->exists($media->path), 404);

        return $disk->response(
            $media->path,
            $media->filename,
            [
                'Content-Type' => (string) $media->mime_type,
                // Media is immutable: an edit uploads a new row rather than rewriting bytes, so the
                // client and the service worker can both hold it indefinitely. The checksum is the
                // ETag, which makes a revalidation free when one does happen.
                'Cache-Control' => 'private, max-age=31536000, immutable',
                'ETag' => '"'.$media->checksum.'"',
            ],
            'inline',
        );
    }
}
