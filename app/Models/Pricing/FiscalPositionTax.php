<?php

declare(strict_types=1);

namespace App\Models\Pricing;

use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** One mapping row; `tax_dest_id = NULL` means "remove this tax" (spec §2.C). */
class FiscalPositionTax extends Model implements PosLoadable
{
    use IsPosLoadable;

    protected $table = 'fiscal_position_taxes';

    protected $guarded = [];

    /** @return BelongsTo<FiscalPosition, $this> */
    public function fiscalPosition(): BelongsTo
    {
        return $this->belongsTo(FiscalPosition::class);
    }

    /** @return BelongsTo<Tax, $this> */
    public function sourceTax(): BelongsTo
    {
        return $this->belongsTo(Tax::class, 'tax_src_id');
    }

    /** @return BelongsTo<Tax, $this> */
    public function destinationTax(): BelongsTo
    {
        return $this->belongsTo(Tax::class, 'tax_dest_id');
    }

    public function isRemoval(): bool
    {
        return $this->tax_dest_id === null;
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn(
            'fiscal_position_id',
            FiscalPosition::posLoadScope($config, $profile)->select('id'),
        );
    }
}
