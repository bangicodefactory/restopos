<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Pos;

use App\Events\Pos\CustomerDisplayUpdated;
use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PosConfig;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The customer display's server side (REG-352, REG-354, BAN-443a).
 *
 * Three endpoints and one asymmetry that explains all of them: **the register holds a device token
 * and the display holds nothing.**
 *
 *   * `POST /api/pos/customer-display` — the register, authenticated as a device with
 *     `pos:realtime`, relays one frame. The device's own config decides the channel, so a till
 *     cannot drive another venue's screen.
 *   * `GET  /api/pos/customer-display/{config}` — the display's branding, keyed by the capability
 *     token in its URL.
 *   * `GET  /api/pos/customer-display/{config}/background` — the configured background *bytes*.
 *
 * ── Why branding is not served by `GET /api/pos/media/{id}` ──
 *
 * That route sits behind `device.can:pos:catalog`, and the display shell is propless and
 * tokenless: it has no bearer to send and no IndexedDB blob store to keep the bytes in. Giving it
 * one is not a small addition — it would need a pairing screen, a boot phase and token storage on
 * a screen that faces the public — so BAN-443a deliberately did not.
 *
 * The honest alternative is this pair of narrow, capability-scoped reads. They differ from the
 * media route in exactly the way that makes them safe without a token:
 *
 *   * the capability is *in the URL*, which is what lets a plain `<img>`/CSS background work at all
 *     (a header cannot be attached to either), and
 *   * **one** media row is reachable — whatever `customer_display_bg_media_id` points at — rather
 *     than any id the caller cares to name. There is no id parameter to walk.
 *
 * The token is compared with `hash_equals`, and it is not `access_token`: see
 * `PosConfig::customerDisplayToken()` for why the self-order token would have been the wrong one.
 */
final class CustomerDisplayController extends Controller
{
    use ResolvesDeviceContext;

    /** A frame the display can actually render; anything else is a client bug, not a screen. */
    private const KINDS = ['idle', 'order', 'paid'];

    /**
     * Relay one frame from the register to its display (REG-352).
     *
     * Returns 202: the register is telling the socket about a screen, not asking the server to
     * record anything. Nothing here is persisted, and a failure costs a lagging display and
     * nothing else — which is why the client fires this and does not await it.
     */
    public function update(Request $request): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);

        $request->validate([
            'payload' => ['required', 'array'],
            'payload.kind' => ['required', 'string', 'in:'.implode(',', self::KINDS)],
            // A screen, not a document. No bill anyone has rung comes near this, and the cap is
            // what stops a misbehaving client pushing a megabyte onto a socket every keystroke.
            'payload.lines' => ['sometimes', 'array', 'max:200'],
        ]);

        // The **raw** input, not `validated()`. The projection is deliberately opaque — the server
        // never interprets it, the display renders it — so there is no rule naming `total`,
        // `lines` or `currency`, and `validated()` returns only the keys rules mention. It shipped
        // `['kind' => 'order']` and nothing else the first time this was written; the display drew
        // an order with no lines and no total, and the socket looked perfectly healthy.
        /** @var array<string, mixed> $payload */
        $payload = (array) $request->input('payload');

        CustomerDisplayUpdated::dispatch(
            $config->customerDisplayToken(),
            $payload,
            (string) $device->uuid,
        );

        return response()->json(['accepted' => true], 202);
    }

    /**
     * What the display needs before its first frame arrives: the venue's name and its background.
     *
     * `background` is a URL rather than an id, because the display has no way to turn an id into
     * bytes — it holds no token and no blob store. Null when the venue configured none, which is
     * the ordinary case and renders the plain dark shell.
     */
    public function show(Request $request, PosConfig $config): JsonResponse
    {
        $this->assertToken($request, $config);

        $background = $this->background($config);

        return response()->json([
            'data' => [
                'venue' => $config->company?->name,
                'channel' => 'pos.display.'.$config->customerDisplayToken(),
                'background' => $background === null
                    ? null
                    : route('api.pos.customer-display.background', [
                        'config' => $config->getKey(),
                        'token' => $config->customerDisplayToken(),
                    ]),
            ],
        ]);
    }

    /**
     * The background bytes (REG-354).
     *
     * Streamed under the same capability token, and only for the one media row the config points
     * at. `Cache-Control` is `public` rather than `private` because this response carries no
     * per-viewer data — the venue's own wallpaper — and a display on a venue LAN behind a caching
     * proxy should be allowed to keep it.
     */
    public function backgroundBytes(Request $request, PosConfig $config): Response|StreamedResponse
    {
        $this->assertToken($request, $config);

        $media = $this->background($config);

        abort_if($media === null, 404);

        $disk = Storage::disk($media->disk);

        abort_unless($disk->exists($media->path), 404);

        return $disk->response(
            $media->path,
            $media->filename,
            [
                'Content-Type' => (string) $media->mime_type,
                'Cache-Control' => 'public, max-age=31536000, immutable',
                'ETag' => '"'.$media->checksum.'"',
            ],
            'inline',
        );
    }

    /**
     * The configured background, or null.
     *
     * The collection is re-checked rather than trusted from the foreign key: the back office picks
     * the id, and nothing there stops a manager pointing the column at a scanned document. A POS
     * collection is what a POS surface may render.
     */
    private function background(PosConfig $config): ?MediaFile
    {
        $media = $config->customerDisplayBackground()->first();

        if (! $media instanceof MediaFile) {
            return null;
        }

        return in_array($media->collection->value, MediaFile::posCollections(), true) ? $media : null;
    }

    /**
     * 404, not 403: an unknown token should not confirm that the config exists.
     *
     * `$given !== ''` survives mutation testing today, and deliberately stays. `hash_equals`
     * already returns false on a length mismatch, and `customerDisplayToken()` is always exactly
     * 40 hex characters — asserted in `CustomerDisplayTest`, which is what makes the clause
     * redundant rather than wishful. It is not redundant in the state that would matter: an
     * expected value of `''` makes `hash_equals('', '')` true and turns this into an open door,
     * and that is the shape a future change to the derivation could take. No test can reach that
     * branch without first breaking the property the shape assertion holds, so it is recorded here
     * rather than covered.
     */
    private function assertToken(Request $request, PosConfig $config): void
    {
        $given = (string) $request->query('token', '');

        abort_unless($given !== '' && hash_equals($config->customerDisplayToken(), $given), 404);
    }
}
