<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/**
 * Named permission bundle, replacing Odoo's `res.groups` implied-group graph
 * (flattened at seed time — spec §2.A / §4.8).
 */
class Role extends Model
{
    protected $table = 'roles';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['is_system' => 'boolean'];
    }

    public const ADMIN = 'admin';

    public const POS_MANAGER = 'pos_manager';

    public const POS_USER = 'pos_user';

    public const REPORT_VIEWER = 'report_viewer';

    /** @return BelongsToMany<Permission, $this> */
    public function permissions(): BelongsToMany
    {
        return $this->belongsToMany(Permission::class, 'permission_role');
    }

    /** @return BelongsToMany<User, $this> */
    public function users(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'role_user');
    }

    public function hasPermission(string $slug): bool
    {
        return $this->permissions->contains('slug', $slug);
    }
}
