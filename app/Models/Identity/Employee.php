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
            'default_role' => EmployeeRole::class,
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
            ->withPivot('access_level')
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
    public function roleFor(PosConfig $config): EmployeeRole
    {
        $level = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot?->access_level;

        if ($level instanceof AccessLevel) {
            return $level->toRole();
        }

        if (is_string($level) && ($parsed = AccessLevel::tryFrom($level)) !== null) {
            return $parsed->toRole();
        }

        return $this->default_role;
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
