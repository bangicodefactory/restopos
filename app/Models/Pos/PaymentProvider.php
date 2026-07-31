<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PaymentProviderCode;
use App\Enums\PaymentProviderState;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Online payment gateway, reduced to the hosted-redirect / QR minimum (spec §2.D). */
class PaymentProvider extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'payment_providers';

    protected $guarded = [];

    protected $hidden = ['credentials'];

    protected function casts(): array
    {
        return [
            'code' => PaymentProviderCode::class,
            'state' => PaymentProviderState::class,
            'credentials' => 'encrypted:array',
            'requires_customer_email' => 'boolean',
            'supported_currencies' => 'array',
            'sequence' => 'integer',
        ];
    }

    /** @return HasMany<PaymentMethod, $this> */
    public function paymentMethods(): HasMany
    {
        return $this->hasMany(PaymentMethod::class);
    }

    /** @return HasMany<PaymentTransaction, $this> */
    public function transactions(): HasMany
    {
        return $this->hasMany(PaymentTransaction::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeUsable(Builder $query): Builder
    {
        return $query->whereIn('state', [PaymentProviderState::Test->value, PaymentProviderState::Enabled->value]);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'id',
            PaymentMethod::posLoadScope($config, $profile)->whereNotNull('payment_provider_id')->select('payment_provider_id'),
        );
    }

    /** @return list<string> */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return ['id', 'name', 'code', 'state', 'requires_customer_email', 'supported_currencies'];
    }
}
