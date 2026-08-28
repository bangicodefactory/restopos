<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\PrinterType;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Kitchen\PrintJob;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Preparation (kitchen/bar) or receipt printer with category routing (spec §2.D). */
class PosPrinter extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use IsPosLoadable;

    protected $table = 'pos_printers';

    protected $guarded = [];

    /**
     * `pos_category_ids` is a pivot materialised into the row, exactly as
     * {@see Product::getPosCategoryIdsAttribute()} does it — the register
     * routes a prep ticket by intersecting the line's categories with the printer's, and cannot
     * issue a second query mid-service to find out what a printer covers.
     *
     * @var list<string>
     */
    protected $appends = ['pos_category_ids'];

    protected function casts(): array
    {
        return [
            'printer_type' => PrinterType::class,
            'printer_port' => 'integer',
            'is_receipt_printer' => 'boolean',
            'print_all_categories' => 'boolean',
            'characters_per_line' => 'integer',
            'copies' => 'integer',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /** @return BelongsToMany<PosCategory, $this> */
    public function categories(): BelongsToMany
    {
        return $this->belongsToMany(PosCategory::class, 'pos_category_pos_printer');
    }

    /** @return BelongsToMany<PosConfig, $this> */
    public function posConfigs(): BelongsToMany
    {
        return $this->belongsToMany(PosConfig::class, 'pos_config_printer');
    }

    /** @return HasMany<PrintJob, $this> */
    public function jobs(): HasMany
    {
        return $this->hasMany(PrintJob::class);
    }

    /** Routing: everything, or only the frozen categories of the line. */
    public function handlesCategory(?int $posCategoryId): bool
    {
        if ($this->print_all_categories) {
            return true;
        }

        return $posCategoryId !== null && $this->categories->contains('id', $posCategoryId);
    }

    /**
     * The POS categories this printer is responsible for, flattened for the client contract.
     *
     * Guarded on `relationLoaded` like Product's: an unloaded relation must yield `[]` rather than
     * silently firing a query per printer inside the bootstrap loop.
     *
     * @return list<int>
     */
    public function getPosCategoryIdsAttribute(): array
    {
        return $this->relationLoaded('categories')
            ? $this->categories->pluck('id')->map(intval(...))->all()
            : [];
    }

    /**
     * Where this printer is reached, as one string, per transport.
     *
     * The DB keeps the Odoo-parity column names (`proxy_ip`, `printer_ip`, `printer_port`) because
     * the back office and docs/odoo-analysis are written against them. The client contract wants a
     * single `address` it can hand to a transport, so the join happens here rather than being
     * re-derived in three places on the other side of the wire.
     */
    public function getAddressAttribute(): ?string
    {
        return match ($this->printer_type) {
            // The IoT box / print agent is addressed as a proxy host; the printer behind it is
            // selected by `epos_device_id`, not by an address of its own.
            PrinterType::Iot => $this->proxy_ip,
            PrinterType::EpsonEpos, PrinterType::NetworkEscpos => $this->printer_ip === null
                ? null
                : ($this->printer_port === null ? $this->printer_ip : $this->printer_ip.':'.$this->printer_port),
            // The browser transport prints through the OS dialog and has nowhere to point.
            default => null,
        };
    }

    /**
     * Rename and derive DB columns into the field names the register reads
     * (packages/domain `PosPrinterRow`).
     *
     * This exists because those two shapes had never actually met. `PosPrinterRow` declared
     * `address`, `print_receipt` and `pos_category_ids`; `pos_printers` has `printer_ip`,
     * `is_receipt_printer` and a pivot; and `posLoadFields()` returned `['*']`, so the raw columns
     * shipped under their own names. Every field the client read came back `undefined`: every
     * printer was born `role: 'prep'` (a receipt printer included), with `categoryIds: undefined`,
     * and the first prep ticket of the shift threw a TypeError inside `resolveTargets`.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    public function toPosRow(array $row): array
    {
        $row['address'] = $this->address;

        if (array_key_exists('is_receipt_printer', $row)) {
            $row['print_receipt'] = (bool) $row['is_receipt_printer'];
            unset($row['is_receipt_printer']);
        }

        // Kept under its own name: it is not the same thing as an empty `pos_category_ids`, which
        // the router treats as the "everything else" fallback rather than as "everything".
        if (array_key_exists('print_all_categories', $row)) {
            $row['print_all_categories'] = (bool) $row['print_all_categories'];
        }

        // Addressing detail the client reassembles from `address`; shipping them as well would
        // give the register two sources for one fact.
        unset($row['proxy_ip'], $row['printer_ip'], $row['printer_port']);

        return $row;
    }

    /**
     * @return list<string>
     */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        return [
            'id', 'name', 'printer_type', 'proxy_ip', 'printer_ip', 'printer_port',
            'epos_device_id', 'profile', 'is_receipt_printer', 'print_all_categories',
            'characters_per_line', 'copies', 'sequence',
        ];
    }

    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            // `pos_category_ids` is appended off this relation; without it every printer ships an
            // empty category list and prep routing silently falls through to the receipt printer.
            ->with('categories:id')
            ->whereHas('posConfigs', fn (Builder $q) => $q->whereKey($config->getKey()))
            ->orderBy('sequence')
            ->orderBy('id');
    }
}
