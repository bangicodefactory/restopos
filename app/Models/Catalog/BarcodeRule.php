<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Enums\BarcodeEncoding;
use App\Enums\BarcodeRuleType;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One decoding rule: this is how weighed/priced/discount labels and
 * cashier/customer badges are resolved offline (spec §2.B / §4.10).
 */
class BarcodeRule extends Model implements PosLoadable
{
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'barcode_rules';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'rule_type' => BarcodeRuleType::class,
            'encoding' => BarcodeEncoding::class,
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsTo<BarcodeNomenclature, $this> */
    public function nomenclature(): BelongsTo
    {
        return $this->belongsTo(BarcodeNomenclature::class, 'barcode_nomenclature_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, BarcodeRuleType $type): Builder
    {
        return $query->where('rule_type', $type->value);
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->whereIn('barcode_nomenclature_id', BarcodeNomenclature::posLoadScope($config, $profile)->select('id'))
            ->orderBy('sequence');
    }
}
