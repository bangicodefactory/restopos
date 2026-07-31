<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Identity\Company;
use App\Models\Identity\Employee;
use App\Models\Identity\MediaFile;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Collection;

/**
 * Back-office / API login (spec §2.A).
 *
 * A user is a *person with a password*; the cashier at the register is an
 * {@see Employee} (who may or may not have a user). A super-admin bypasses
 * permission checks but may never open a POS session (Odoo `open_ui` guard).
 */
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory;

    use Notifiable;
    use SoftDeletes;

    protected $guarded = [];

    /** @var list<string> */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_super_admin' => 'boolean',
            'last_login_at' => 'datetime',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<Company, $this> */
    public function company(): BelongsTo
    {
        return $this->belongsTo(Company::class);
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function avatar(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'avatar_media_id');
    }

    /** @return BelongsToMany<Role, $this> */
    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class, 'role_user');
    }

    /** @return HasOne<Employee, $this> */
    public function employee(): HasOne
    {
        return $this->hasOne(Employee::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeActive(Builder $query): Builder
    {
        return $query->where('active', true);
    }

    public function hasRole(string $slug): bool
    {
        return $this->roles->contains('slug', $slug);
    }

    public function hasPermission(string $slug): bool
    {
        if ($this->is_super_admin) {
            return true;
        }

        return $this->permissionSlugs()->contains($slug);
    }

    /** @return Collection<int, string> */
    public function permissionSlugs(): Collection
    {
        return $this->roles
            ->loadMissing('permissions')
            ->flatMap(fn (Role $role) => $role->permissions->pluck('slug'))
            ->unique()
            ->values();
    }

    /** Super admins cannot open a register session (Odoo `open_ui` guard). */
    public function canOpenSession(): bool
    {
        return ! $this->is_super_admin && $this->active;
    }
}
