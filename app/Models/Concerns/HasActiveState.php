<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use Illuminate\Database\Eloquent\Builder;

/**
 * Archivable master data (Odoo's `active`). Clients are still sent `active=false`
 * rows so they can purge them locally (spec §0.2, §5.5 tombstones).
 */
trait HasActiveState
{
    /** @param  Builder<static>  $query */
    public function scopeActive(Builder $query): Builder
    {
        return $query->where($this->getTable().'.active', true);
    }

    /** @param  Builder<static>  $query */
    public function scopeArchived(Builder $query): Builder
    {
        return $query->where($this->getTable().'.active', false);
    }

    public function archive(): bool
    {
        return $this->forceFill(['active' => false])->save();
    }

    public function restoreActive(): bool
    {
        return $this->forceFill(['active' => true])->save();
    }
}
