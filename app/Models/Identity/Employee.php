<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Enums\AccessLevel;
use App\Enums\EmployeeRole;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\CashMovement;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Cashier identity at the register (badge + PIN login) and the attribution
 * target for orders, payments and cash movements (spec §2.A).
 *
 * Raw `barcode` / PIN never leave the server: the client receives
 * `barcode_hash` and a `has_pin` flag only (spec §5.3).
 */
class Employee extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'employees';

    protected $guarded = [];

    protected $hidden = ['barcode', 'pin_hash'];

    protected function casts(): array
    {
        return [
            // A plain string since BAN-451, not the enum. A venue can author "Shift lead", and an
            // enum cast would throw `ValueError` the moment such a row was read back — on the
            // bootstrap payload, so the till would fail to load rather than fail to grant.
            // `roleFor()` still answers in the enum for the callers typed on it, falling back to the
            // employee's system role when the slug is one the enum does not know.
            'default_role' => 'string',
            'color' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function avatar(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'avatar_media_id');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_employee')
            ->withPivot('access_level', 'role_slug')
            ->withTimestamps();
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    /** @return HasMany<CashMovement, $this> */
    public function cashMovements(): HasMany
    {
        return $this->hasMany(CashMovement::class);
    }

    public function hasPin(): bool
    {
        return filled($this->pin_hash);
    }

    public function checkPin(string $pin): bool
    {
        return $this->hasPin() && hash_equals((string) $this->pin_hash, hash('sha256', $pin));
    }

    public function checkBarcode(string $barcode): bool
    {
        return filled($this->barcode_hash) && hash_equals((string) $this->barcode_hash, hash('sha256', $barcode));
    }

    /** Effective register role, taking the per-config access level into account. */
    /**
     * The role slug for this employee on this register, custom roles included (BAN-451).
     *
     * `roleFor()` below answers the same question in the enum, which by construction cannot name a
     * role a venue invented. The pivot's `role_slug` wins when set, then `access_level`, then the
     * employee's own default — the same order as before, with one rung added at the top.
     *
     * That rung is the whole reason the column exists: `access_level` defaults to `basic` and is
     * therefore *always* set once an employee is attached to a register, so `roleFor()` never
     * reached `default_role` for an attached employee. A custom role written to `default_role`
     * alone would have applied to exactly the employees no register had been given.
     */
    /**
     * Accept the enum as well as the slug.
     *
     * This column was an enum cast until BAN-451 made a role a row, so passing `EmployeeRole::Manager`
     * was the natural thing to write and several callers do. Under a plain `string` cast that throws
     * "could not be converted to string" — at the write, far from the reader that would explain it.
     * Unwrapping here keeps every one of those callers correct instead of relocating the break.
     */
    protected function setDefaultRoleAttribute(mixed $value): void
    {
        $this->attributes['default_role'] = $value instanceof \BackedEnum
            ? (string) $value->value
            : (string) $value;
    }

    public function roleSlugFor(PosConfig $config): string
    {
        $pivot = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot;

        $custom = $pivot?->role_slug;

        if (is_string($custom) && $custom !== '') {
            return $custom;
        }

        // No pivot row at all means this register has not been given a staff list, and every active
        // employee may log in on their own default — which is where a custom `default_role` has to
        // survive rather than being flattened onto the nearest enum case.
        if ($pivot === null && is_string($this->default_role) && $this->default_role !== '') {
            return $this->default_role;
        }

        return $this->roleFor($config)->value;
    }

    public function roleFor(PosConfig $config): EmployeeRole
    {
        $level = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot?->access_level;

        if ($level instanceof AccessLevel) {
            return $level->toRole();
        }

        if (is_string($level) && ($parsed = AccessLevel::tryFrom($level)) !== null) {
            return $parsed->toRole();
        }

        return EmployeeRole::tryFrom((string) $this->default_role) ?? EmployeeRole::Cashier;
    }

    /**
     * If the config has employee rows, only those employees; otherwise every
     * active company employee (Odoo rule preserved — spec §2.A).
     *
     * @return Builder<static>
     */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->when(
                $config->employees()->exists(),
                fn (Builder $q) => $q->whereHas('posConfigs', fn (Builder $c) => $c->whereKey($config->getKey())),
                fn (Builder $q) => $q->where('active', true),
            );
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return ['id', 'name', 'job_title', 'avatar_media_id', 'barcode_hash', 'default_role', 'color', 'active'];
    }
}
