<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Enums\MediaCollection;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Support\Facades\Storage;

/**
 * Every image/attachment: product photos, category tiles, floor backgrounds,
 * kiosk carousels, brand logos, receipt images (spec §2.A).
 *
 * The bootstrap payload ships metadata only — never binary (spec §5.3). The bytes come from
 * `GET /media/{media}`, which the register's service worker already caches (`sw.ts`, rule 4:
 * "Product imagery — nice to have, never blocking, LRU-capped").
 *
 * That split is why images work offline without bloating the replica: a product photo is an HTTP
 * resource the service worker keeps until it needs the space, while the receipt logo — which a
 * printer blocks on and which must survive an eviction — is pulled into the Dexie blob store under
 * `logo:{id}`, where `quota.ts` deliberately spares it (BAN-480).
 */
class MediaFile extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasUuid;
    use IsPosLoadable;

    protected $table = 'media_files';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'collection' => MediaCollection::class,
            'variants' => 'array',
            'size_bytes' => 'integer',
            'width' => 'integer',
            'height' => 'integer',
            'is_public' => 'boolean',
            'sort_order' => 'integer',
        ];
    }

    /** @return MorphTo<Model, $this> */
    public function model(): MorphTo
    {
        return $this->morphTo(null, 'model_type', 'model_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeInCollection(Builder $query, MediaCollection|string $collection): Builder
    {
        return $query->where('collection', $collection instanceof MediaCollection ? $collection->value : $collection);
    }

    /** @param  Builder<static>  $query */
    public function scopePublic(Builder $query): Builder
    {
        return $query->where('is_public', true);
    }

    /**
     * Only the media this config's clients can actually reference.
     *
     * Sending the company's whole media library would be metadata for images no client will ask
     * for — and on a venue with a marketing folder, most of the payload. Scoped to the collections
     * a POS client renders, which is also the set the `/media` route will serve.
     *
     * @return Builder<static>
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('media_files.company_id', $config->company_id)
            ->whereIn('media_files.collection', self::posCollections())
            ->orderBy('media_files.id');
    }

    /**
     * Metadata only — never `path`, and never the disk.
     *
     * A client that knew the storage path could try to construct a URL to it, and on a public disk
     * that would bypass the route's authorization entirely. The client needs the id to build
     * `/media/{id}`, and the dimensions to lay out without reflow; it needs nothing else.
     *
     * @return list<string>
     */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return ['id', 'uuid', 'collection', 'mime_type', 'width', 'height', 'checksum', 'sort_order'];
    }

    /**
     * The collections a POS client renders.
     *
     * @return list<string>
     */
    public static function posCollections(): array
    {
        return [
            // Product and category tiles, the kiosk's home and background art, the brand mark, and
            // the receipt logo. Not `avatar` or `document`: no POS surface renders either, and a
            // scanned invoice is not something a till should be able to fetch.
            MediaCollection::Image->value,
            MediaCollection::SelfHome->value,
            MediaCollection::SelfBackground->value,
            MediaCollection::Brand->value,
            MediaCollection::FloorBackground->value,
            MediaCollection::ReceiptLogo->value,
        ];
    }

    public function url(?int $size = null): string
    {
        $path = $this->path;

        if ($size !== null && is_array($this->variants) && isset($this->variants[(string) $size])) {
            $path = $this->variants[(string) $size];
        }

        return Storage::disk($this->disk)->url($path);
    }
}
