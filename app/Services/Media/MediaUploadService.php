<?php

declare(strict_types=1);

namespace App\Services\Media;

use App\Enums\MediaCollection;
use App\Models\Identity\MediaFile;
use Illuminate\Contracts\Filesystem\Factory as FilesystemFactory;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;

/**
 * The write half of the media pipeline (BAN-393).
 *
 * The read half shipped with BAN-480 — `GET /api/pos/media/{id}` serves a file to a paired device,
 * `resources/js/shared/media/store.ts` caches it, and the receipt builder already emits an image
 * node keyed on `receipt_logo_media_id`. **Nothing could ever put a file there.** There was no
 * upload route in the application, no call to `$request->file()` anywhere in `app/`, and the only
 * code that had ever created a `media_files` row was the accounting exporter writing a generated
 * CSV. Every picker in the back office was a `Notice` explaining why it was not a picker.
 *
 * ## Two decisions worth stating
 *
 * **The stored name is the checksum, not the uploaded filename.** A filename arrives from a browser
 * and is attacker-controlled: `../../.env`, a 300-character name, a name that differs from another
 * only by case on a case-insensitive disk. Hashing sidesteps all of it, and gives deduplication for
 * free — the same logo uploaded to five registers is one file on disk. The original name is kept in
 * the `filename` column, which is display text and never a path.
 *
 * **The mime type is sniffed, never trusted.** `UploadedFile::getClientMimeType()` is whatever the
 * browser said. `getMimeType()` reads the file. A `.png` that is actually an HTML document matters
 * because `MediaController` streams these back with the recorded type in the header.
 */
final readonly class MediaUploadService
{
    /**
     * Deliberately narrow. Every collection the POS renders is a raster image.
     *
     * **SVG is excluded, and that is a security decision rather than an oversight.** An SVG is a
     * document: it can carry `<script>`, and `MediaController` streams these back inline from the
     * application's own origin with the recorded mime type. Allowing it would mean any operator who
     * can upload a logo can run script in every other operator's session — stored XSS, in exchange
     * for a file format PNG already covers.
     */
    public const ALLOWED_MIME = [
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif',
    ];

    public function __construct(private FilesystemFactory $filesystems) {}

    public function store(
        UploadedFile $file,
        MediaCollection $collection,
        int $companyId,
        bool $public = false,
    ): MediaFile {
        $checksum = (string) hash_file('sha256', $file->getRealPath());
        $disk = $public ? 'public' : 'local';

        // Deduplicated within the venue and the collection. Not globally: two companies uploading
        // the same stock photo must not end up sharing a row, because either could then delete the
        // other's logo.
        $existing = MediaFile::query()
            ->where('company_id', $companyId)
            ->where('collection', $collection->value)
            ->where('checksum', $checksum)
            ->first();

        if ($existing !== null) {
            return $existing;
        }

        $extension = $this->extensionFor($file);
        $path = $collection->value.'/'.$companyId.'/'.$checksum.$extension;

        $this->filesystems->disk($disk)->putFileAs(
            dirname($path),
            $file,
            basename($path),
        );

        [$width, $height] = $this->dimensions($file);

        /** @var MediaFile $media */
        $media = MediaFile::query()->create([
            'uuid' => (string) Str::uuid(),
            'company_id' => $companyId,
            'collection' => $collection->value,
            'disk' => $disk,
            'path' => $path,
            // Display text only. It is never joined into a path — see the class docblock.
            'filename' => mb_substr((string) $file->getClientOriginalName(), 0, 255),
            'mime_type' => $this->mimeFor($file),
            'size_bytes' => (int) $file->getSize(),
            'width' => $width,
            'height' => $height,
            'checksum' => $checksum,
            'is_public' => $public,
        ]);

        return $media;
    }

    /** Sniffed from the bytes, never taken from the browser. */
    public function mimeFor(UploadedFile $file): string
    {
        return (string) ($file->getMimeType() ?? 'application/octet-stream');
    }

    /**
     * From the sniffed type, not from the uploaded name.
     *
     * A name ending in `.png` proves nothing, and the extension ends up in the stored path.
     */
    private function extensionFor(UploadedFile $file): string
    {
        return match ($this->mimeFor($file)) {
            'image/png' => '.png',
            'image/jpeg' => '.jpg',
            'image/webp' => '.webp',
            'image/gif' => '.gif',
            default => '',
        };
    }

    /**
     * @return array{0: ?int, 1: ?int}
     */
    private function dimensions(UploadedFile $file): array
    {
        // Suppressed rather than trusted: `getimagesize` warns and returns false on anything it
        // cannot read, and a file that is not the image it claims to be is exactly what we expect
        // to see here occasionally.
        $size = @getimagesize($file->getRealPath());

        if ($size === false) {
            return [null, null];
        }

        return [
            $size[0] > 0 && $size[0] <= 65535 ? (int) $size[0] : null,
            $size[1] > 0 && $size[1] <= 65535 ? (int) $size[1] : null,
        ];
    }
}
