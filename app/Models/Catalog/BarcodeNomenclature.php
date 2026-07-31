<?php

declare(strict_types=1);

namespace App\Models\Catalog;

use App\Enums\UpcEanConversion;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Barcode decoding profile; NULL company means global (spec §2.B). */
class BarcodeNomenclature extends Model implements PosLoadable
{
    use BelongsToCompany;
    use IsPosLoadable;

    protected $table = 'barcode_nomenclatures';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'upc_ean_conv' => UpcEanConversion::class,
            'is_gs1' => 'boolean',
        ];
    }

    /** @return HasMany<BarcodeRule, $this> */
    public function rules(): HasMany
    {
        return $this->hasMany(BarcodeRule::class)->orderBy('sequence');
    }

    /** The company nomenclature plus the config's fallback (spec §5.3). */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()->whereIn('id', array_filter([
            $config->company?->barcode_nomenclature_id,
            $config->fallback_barcode_nomenclature_id,
        ]));
    }
}
