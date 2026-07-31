<?php

declare(strict_types=1);

namespace App\Services\Pos;

use App\Models\Catalog\BarcodeNomenclature;
use App\Models\Catalog\BarcodeRule;
use App\Models\Catalog\Combo;
use App\Models\Catalog\ComboItem;
use App\Models\Catalog\PosCategory;
use App\Models\Catalog\Product;
use App\Models\Catalog\ProductAttribute;
use App\Models\Catalog\ProductAttributeExclusion;
use App\Models\Catalog\ProductAttributeLine;
use App\Models\Catalog\ProductAttributeLineValue;
use App\Models\Catalog\ProductAttributeValue;
use App\Models\Catalog\ProductCategory;
use App\Models\Catalog\ProductPackaging;
use App\Models\Catalog\ProductTag;
use App\Models\Catalog\ProductVariant;
use App\Models\Catalog\Uom;
use App\Models\Concerns\PosLoadable;
use App\Models\Identity\Customer;
use App\Models\Kitchen\PrepDisplay;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PaymentProvider;
use App\Models\Pos\PosBill;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosNote;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PosPrinter;
use App\Models\Pos\PresetServiceWindow;
use App\Models\Pos\Setting;
use App\Models\Pricing\CashRounding;
use App\Models\Pricing\Currency;
use App\Models\Pricing\DecimalPrecision;
use App\Models\Pricing\FiscalPosition;
use App\Models\Pricing\FiscalPositionTax;
use App\Models\Pricing\Pricelist;
use App\Models\Pricing\PricelistItem;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table;

/**
 * The ordered list of entities that ship in a bootstrap / delta payload
 * (spec 01-schema §5.2 — dependency order, referents first).
 *
 * Adding a model to the payload is adding one line here plus a `PosLoadable`
 * implementation on the model. There is no reflection and no metadata protocol:
 * the client's types are known at compile time (spec 03 §0).
 *
 * Entities owned by a domain another agent may still be writing are resolved
 * through `class_exists()` so a partially-built tree still boots.
 */
final class BootstrapRegistry
{
    /**
     * Payload key => model class. Order is load order.
     *
     * @var array<string, class-string>
     */
    private const MODELS = [
        // 1 — money & precision
        'settings' => Setting::class,
        'decimal_precisions' => DecimalPrecision::class,
        'currencies' => Currency::class,
        'cash_roundings' => CashRounding::class,

        // 2 — tax
        'tax_groups' => TaxGroup::class,
        'taxes' => Tax::class,
        'fiscal_positions' => FiscalPosition::class,
        'fiscal_position_taxes' => FiscalPositionTax::class,

        // 3 — units & categories
        'uoms' => Uom::class,
        'pos_categories' => PosCategory::class,
        'product_categories' => ProductCategory::class,
        'product_tags' => ProductTag::class,

        // 4 — catalog
        'products' => Product::class,
        'product_variants' => ProductVariant::class,
        'product_packagings' => ProductPackaging::class,
        'product_attributes' => ProductAttribute::class,
        'product_attribute_values' => ProductAttributeValue::class,
        'product_attribute_lines' => ProductAttributeLine::class,
        'product_attribute_line_values' => ProductAttributeLineValue::class,
        'product_attribute_exclusions' => ProductAttributeExclusion::class,
        'combos' => Combo::class,
        'combo_items' => ComboItem::class,

        // 5 — pricing
        'pricelists' => Pricelist::class,
        'pricelist_items' => PricelistItem::class,

        // 6 — scanning
        'barcode_nomenclatures' => BarcodeNomenclature::class,
        'barcode_rules' => BarcodeRule::class,

        // 7 — register configuration
        'payment_providers' => PaymentProvider::class,
        'payment_methods' => PaymentMethod::class,
        'pos_presets' => PosPreset::class,
        'preset_service_windows' => PresetServiceWindow::class,
        'pos_notes' => PosNote::class,
        'pos_bills' => PosBill::class,
        'pos_printers' => PosPrinter::class,

        // 8 — restaurant & kitchen (optional domains)
        'restaurant_floors' => Floor::class,
        'restaurant_tables' => Table::class,
        'prep_displays' => PrepDisplay::class,

        // 9 — people & devices
        'customers' => Customer::class,
        'pos_devices' => PosDevice::class,
    ];

    /** Entities that are paginated instead of being sent whole. */
    public const PAGINATED = ['products', 'customers'];

    /**
     * Entities that are always sent in full, never `since`-filtered
     * (spec 01-schema §5.5).
     */
    public const ALWAYS_FULL = ['settings', 'decimal_precisions', 'pos_configs', 'pos_sessions'];

    /**
     * Entities not derived from a `PosLoadable` model — assembled by hand by
     * {@see BootstrapService} because they need per-device or graph treatment.
     */
    public const SYNTHETIC = ['pos_config', 'pos_session', 'employees', 'open_orders'];

    /**
     * Resolved payload key => class map for the entities that actually exist.
     *
     * @return array<string, class-string<PosLoadable>>
     */
    public static function models(): array
    {
        /** @var array<string, class-string<PosLoadable>>|null $resolved */
        static $resolved = null;

        if ($resolved !== null) {
            return $resolved;
        }

        $out = [];

        foreach (self::MODELS as $name => $class) {
            if (class_exists($class) && is_subclass_of($class, PosLoadable::class)) {
                /** @var class-string<PosLoadable> $class */
                $out[$name] = $class;
            }
        }

        return $resolved = $out;
    }

    /** @return list<string> */
    public static function names(): array
    {
        return array_keys(self::models());
    }

    /** @return class-string<PosLoadable>|null */
    public static function classFor(string $name): ?string
    {
        return self::models()[$name] ?? null;
    }
}
