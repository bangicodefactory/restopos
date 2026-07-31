<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;

/**
 * Default implementation of {@see PosLoadable}.
 *
 * The defaults cover plain company-scoped master data: filter on
 * `company_id = cfg.company_id`, ship every column, key by id. Entities with a
 * narrower scope (products capped by `limited_product_count`, orders limited to
 * drafts, employees limited by `pos_config_employee`, …) override
 * `posLoadScope()` / `posLoadFields()`.
 */
trait IsPosLoadable
{
    /** @return Builder<static> */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        $query = static::query();
        $model = new static;

        if (in_array('company_id', $model->getPosLoadableColumns(), true)) {
            $query->where($model->getTable().'.company_id', $config->company_id);
        }

        if (in_array('active', $model->getPosLoadableColumns(), true)) {
            // active=false rows are still sent so the client can purge them (§5.5).
            $query->orderBy($model->getTable().'.id');
        }

        return $query;
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return ['*'];
    }

    public static function posLoadName(): string
    {
        return (new static)->getTable();
    }

    public static function posLoadKeyedByUuid(): bool
    {
        return in_array(HasUuid::class, class_uses_recursive(static::class), true);
    }

    /**
     * Incremental sync: rows changed strictly after the watermark
     * (`?since=`, ms precision, spec §5.5).
     *
     * @param  Builder<static>  $query
     */
    public function scopeSyncedSince(Builder $query, \DateTimeInterface|string|null $since): Builder
    {
        if ($since === null) {
            return $query;
        }

        return $query->where($this->getTable().'.updated_at', '>', $since);
    }

    /**
     * Rows the client must purge: soft-deleted or archived since the watermark.
     *
     * @param  Builder<static>  $query
     */
    public function scopeTombstonedSince(Builder $query, \DateTimeInterface|string|null $since): Builder
    {
        $columns = $this->getPosLoadableColumns();

        return $query
            ->when($since !== null, fn (Builder $q) => $q->where($this->getTable().'.updated_at', '>', $since))
            ->where(function (Builder $q) use ($columns): void {
                if (in_array('deleted_at', $columns, true)) {
                    $q->orWhereNotNull($this->getTable().'.deleted_at');
                }

                if (in_array('active', $columns, true)) {
                    $q->orWhere($this->getTable().'.active', false);
                }
            });
    }

    /**
     * The real column list of the model's table, resolved once per class.
     *
     * Used to decide whether a generic scope may filter on `company_id`,
     * `active` or `deleted_at` without knowing the concrete entity.
     *
     * @return list<string>
     */
    protected function getPosLoadableColumns(): array
    {
        /** @var array<class-string, list<string>> $cache */
        static $cache = [];

        if (isset($cache[static::class])) {
            return $cache[static::class];
        }

        try {
            $columns = $this->getConnection()->getSchemaBuilder()->getColumnListing($this->getTable());
        } catch (\Throwable) {
            $columns = array_keys($this->getCasts());
        }

        return $cache[static::class] = array_values($columns);
    }
}
