<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\MediaCollection;
use App\Http\Controllers\Controller;
use App\Models\Identity\MediaFile;
use App\Services\Media\MediaUploadService;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Contracts\Filesystem\Factory as FilesystemFactory;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Uploading and serving media for the back office (BAN-393).
 *
 * ## Why this returns JSON rather than redirecting
 *
 * Every other write in the back office is an Inertia form post that redirects back. An image picker
 * cannot work that way: the editor needs the **id** of the file it just uploaded so it can put that
 * id in the field it is editing, and a redirect hands back a page, not a value. So the upload is its
 * own endpoint returning `{id, url}`, and the owning form stores the id like any other.
 *
 * The alternative — multipart submits on each editor with `forceFormData` — was rejected because it
 * would put file handling into five unrelated controllers and make every one of those forms unable
 * to save without re-uploading the image.
 *
 * ## Why there is a second serve route
 *
 * `GET /api/pos/media/{id}` already existed, and it is device-authenticated: `device.can:pos:catalog`.
 * A signed-in manager holds no device token, so **the back office could not display an image it had
 * just uploaded** — the picker would show a broken preview. This route answers the same bytes to a
 * `web` session, scoped by the same company rule.
 */
final class MediaController extends Controller
{
    public function __construct(
        private readonly MediaUploadService $uploads,
        private readonly FilesystemFactory $filesystems,
    ) {}

    public function store(Request $request): JsonResponse
    {
        Gate::authorize('create', MediaFile::class);

        $data = $request->validate([
            // `mimetypes` sniffs the file; `mimes` would trust the extension, which is the client's
            // to choose. Both the rule and the service check, because a rule that is loosened later
            // must not silently widen what reaches the disk.
            'file' => ['required', 'file', 'max:8192', 'mimetypes:'.implode(',', MediaUploadService::ALLOWED_MIME)],
            'collection' => ['required', Rule::enum(MediaCollection::class)],
        ]);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'file' => 'Choose a company before uploading an image.',
            ]);
        }

        $collection = MediaCollection::from((string) $data['collection']);

        $media = $this->uploads->store(
            $request->file('file'),
            $collection,
            $companyId,
            // Only the collections an anonymous kiosk visitor renders are public. Everything else
            // stays on the private disk and is reached through `show()`, which checks the session.
            public: in_array($collection, [MediaCollection::SelfHome, MediaCollection::SelfBackground, MediaCollection::Brand], true),
        );

        return new JsonResponse([
            'id' => (int) $media->getKey(),
            'url' => route('media.show', $media->getKey()),
            'filename' => (string) $media->filename,
            'width' => $media->width,
            'height' => $media->height,
        ], 201);
    }

    /** Stream a file back to a signed-in operator. */
    public function show(MediaFile $media): StreamedResponse
    {
        Gate::authorize('view', $media);

        $disk = $this->filesystems->disk((string) $media->disk);

        abort_unless($disk->exists((string) $media->path), 404);

        return $disk->response((string) $media->path, (string) $media->filename, [
            'Content-Type' => (string) $media->mime_type,
            // Uploaded bytes served from the application's own origin. Even with SVG refused at the
            // gate, this says plainly that nothing here is script or a frame — the header costs
            // nothing and does not depend on the upload rules staying as strict as they are today.
            'Content-Security-Policy' => "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            'X-Content-Type-Options' => 'nosniff',
            // The path is a content hash, so a given id's bytes never change.
            'Cache-Control' => 'private, max-age=604800',
        ]);
    }

    public function destroy(MediaFile $media): JsonResponse
    {
        Gate::authorize('delete', $media);

        // The row goes; the file stays. Deduplication means several rows may point at one path, and
        // an orphaned file costs disk while a missing one breaks a receipt that still references it.
        // Reaping unreferenced blobs is a scheduled job's work, not a request's.
        $media->delete();

        return new JsonResponse(null, 204);
    }
}
