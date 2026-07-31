<?php

declare(strict_types=1);

namespace App\Models\Identity;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** Atomic capability checked in policies; seeded, never user-editable (spec §4.8). */
class Permission extends Model
{
    protected $table = 'permissions';

    protected $guarded = [];

    /** @return BelongsToMany<Role, $this> */
    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class, 'permission_role');
    }

    /** @param  Builder<static>  $query */
    public function scopeInGroup(Builder $query, string $group): Builder
    {
        return $query->where('group', $group);
    }
}
