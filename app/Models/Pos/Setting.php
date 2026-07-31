<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\SettingValueType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/** Global key/value replacing `ir.config_parameter` (spec §2.D). NULL company = instance-wide. */
class Setting extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'settings';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['value_type' => SettingValueType::class];
    }

    public function typedValue(): mixed
    {
        return $this->value_type->cast($this->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeKey(Builder $query, string $key): Builder
    {
        return $query->where('key', $key);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->where(fn (Builder $q) => $q
            ->where('company_id', $config->company_id)
            ->orWhereNull('company_id'));
    }
}
