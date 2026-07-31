<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/** Client-side rounding digits per domain (spec §2.C); always sent in full. */
class DecimalPrecision extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'decimal_precisions';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['digits' => 'integer'];
    }

    public const PRODUCT_PRICE = 'Product Price';

    public const PRODUCT_UOM = 'Product Unit of Measure';

    public const DISCOUNT = 'Discount';

    public const PAYMENT_TERMINAL = 'Payment Terminal';

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query();
    }
}
