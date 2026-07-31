<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Str;

/**
 * Client-created / offline-syncable records carry a `uuid` (char(36), unique).
 *
 * The uuid is minted by the client (UUIDv4/v7), never re-issued by the server,
 * and is THE idempotency key of `POST /api/pos/sync`. This trait only fills one
 * in when the row is created server-side (seeders, back-office, tests).
 *
 * @see docs/spec/01-schema.md §0.2
 */
trait HasUuid
{
    public static function bootHasUuid(): void
    {
        static::creating(function (self $model): void {
            if (blank($model->{$model->uuidColumn()})) {
                $model->{$model->uuidColumn()} = (string) Str::uuid();
            }
        });
    }

    public function uuidColumn(): string
    {
        return 'uuid';
    }

    /** Route-model binding and sync lookups happen by uuid, never by id. */
    public function resolveRouteBindingQuery($query, $value, $field = null)
    {
        return $query->where($field ?? $this->uuidColumn(), $value);
    }

    /** @param  Builder<static>  $query */
    public function scopeWhereUuid(Builder $query, string $uuid): Builder
    {
        return $query->where($this->uuidColumn(), $uuid);
    }

    /**
     * @param  Builder<static>  $query
     * @param  array<int, string>  $uuids
     */
    public function scopeWhereUuidIn(Builder $query, array $uuids): Builder
    {
        return $query->whereIn($this->uuidColumn(), $uuids);
    }
}
