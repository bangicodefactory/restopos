<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Enums\MediaCollection;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Support\Facades\Storage;

/**
 * Every image/attachment: product photos, category tiles, floor backgrounds,
 * kiosk carousels, brand logos, receipt images (spec §2.A).
 *
 * The bootstrap payload ships metadata only — never binary (spec §5.3).
 */
class MediaFile extends Model
{
    use BelongsToCompany;
    use HasUuid;

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

    public function url(?int $size = null): string
    {
        $path = $this->path;

        if ($size !== null && is_array($this->variants) && isset($this->variants[(string) $size])) {
            $path = $this->variants[(string) $size];
        }

        return Storage::disk($this->disk)->url($path);
    }
}
