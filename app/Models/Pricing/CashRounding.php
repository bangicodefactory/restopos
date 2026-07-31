<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Enums\CashRoundingMethod;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * Cash rounding profile (spec §2.C). Only the `add_line` strategy exists — Odoo
 * itself constrains the POS to it.
 */
class CashRounding extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'cash_roundings';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'rounding' => 'decimal:6',
            'rounding_method' => CashRoundingMethod::class,
        ];
    }

    /** Round an amount to the configured step, in the configured direction. */
    public function apply(string|float $amount): string
    {
        $step = (float) $this->rounding;

        if ($step <= 0) {
            return (string) $amount;
        }

        $value = (float) $amount / $step;

        $rounded = match ($this->rounding_method) {
            CashRoundingMethod::HalfUp => round($value, 0, PHP_ROUND_HALF_UP),
            CashRoundingMethod::Up => ceil($value),
            CashRoundingMethod::Down => floor($value),
        };

        return number_format($rounded * $step, 4, '.', '');
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereKey($config->cash_rounding_id);
    }
}
