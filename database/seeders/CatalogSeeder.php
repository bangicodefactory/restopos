<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\AttributeCreateVariant;
use App\Enums\AttributeDisplayType;
use App\Enums\BarcodeEncoding;
use App\Enums\BarcodeRuleType;
use App\Enums\ProductType;
use App\Enums\SettingValueType;
use App\Enums\SpecialKind;
use App\Enums\UpcEanConversion;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * The menu of Le Bistro Numérique — ~70 products in 11 register categories.
 *
 * Everything the register has to render at least once is present: attribute
 * variants that move the price (pizza sizes, draught beer formats), no-variant
 * attributes that do not (steak cooking, milk choice), three combo menus with
 * choice sets, weighed products, open-price products, barcoded bottles with
 * packagings, tags, and a barcode nomenclature with the full rule set.
 *
 * Menu names are French; `default_code` / slugs stay ASCII.
 */
class CatalogSeeder extends Seeder
{
    private const CAT_STARTERS = 'Entrées';

    private const CAT_MAINS = 'Plats';

    private const CAT_TAJINES = 'Tajines';

    private const CAT_PIZZAS = 'Pizzas';

    private const CAT_BURGERS = 'Burgers';

    private const CAT_DESSERTS = 'Desserts';

    private const CAT_HOT = 'Boissons chaudes';

    private const CAT_COLD = 'Boissons fraîches';

    private const CAT_BEERS = 'Bières';

    private const CAT_WINES = 'Vins';

    private const CAT_COCKTAILS = 'Cocktails';

    private const CAT_MENUS = 'Menus';

    private int $companyId;

    private string $now;

    /** @var array<string, int> */
    private array $posCategories = [];

    /** @var array<string, int> */
    private array $productCategories = [];

    /** @var array<string, int> */
    private array $tags = [];

    /** @var array<string, int> */
    private array $taxes = [];

    /** @var array<string, int> */
    private array $uoms = [];

    /** @var array<string, array{id: int, values: array<string, int>}> */
    private array $attributes = [];

    /** @var array<string, array{display: AttributeDisplayType, create: AttributeCreateVariant, values: array<string, string>}> */
    private array $attributeMeta = [];

    /** @var array<string, int> product name => id */
    private array $productIds = [];

    /** @var array<string, int> variant display name => id */
    private array $variantIds = [];

    public function run(): void
    {
        Demo::reseed('catalog');

        $companyId = DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === null) {
            return;
        }
        $this->companyId = (int) $companyId;
        $this->now = Demo::ts(Demo::clock());

        if (DB::table('products')->where('company_id', $this->companyId)->exists()) {
            return;
        }

        $this->taxes = DB::table('taxes')
            ->where('company_id', $this->companyId)
            ->pluck('id', 'description')->map(static fn ($value): int => (int) $value)->all();
        $this->uoms = DB::table('uoms')->pluck('id', 'name')->map(static fn ($value): int => (int) $value)->all();

        $this->seedBarcodeNomenclature();
        $this->seedProductCategories();
        $this->seedPosCategories();
        $this->seedTags();
        $this->seedAttributes();
        $this->seedProducts();
        $this->seedCombos();
        $this->seedOptionalProducts();
        $this->seedPackagings();
        $this->seedVariantTaxOverrides();
        $this->seedOpenPriceSetting();
    }

    // ------------------------------------------------------------------ barcodes

    private function seedBarcodeNomenclature(): void
    {
        $nomenclatureId = (int) DB::table('barcode_nomenclatures')->insertGetId([
            'company_id' => $this->companyId,
            'name' => 'Nomenclature Bistro (EAN-13)',
            'upc_ean_conv' => UpcEanConversion::Always->value,
            'is_gs1' => false,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        /** @var list<array{0:string,1:BarcodeRuleType,2:string,3:BarcodeEncoding,4:?string,5:int}> $rules */
        $rules = [
            ['Produit pesé (poids en kg)', BarcodeRuleType::Weight, '23.....{NNDDD}', BarcodeEncoding::Ean13, null, 10],
            ['Produit à prix imprimé', BarcodeRuleType::Price, '24.....{NNNDD}', BarcodeEncoding::Ean13, null, 20],
            ['Remise en pourcentage', BarcodeRuleType::Discount, '22{NN}', BarcodeEncoding::Any, null, 30],
            ['Badge caissier', BarcodeRuleType::Cashier, '041', BarcodeEncoding::Any, null, 40],
            ['Carte client', BarcodeRuleType::Customer, '042', BarcodeEncoding::Any, null, 50],
            ['Coupon / carte cadeau', BarcodeRuleType::Coupon, '049', BarcodeEncoding::Any, null, 60],
            ['Numéro de lot', BarcodeRuleType::Lot, '21', BarcodeEncoding::Any, null, 70],
            ['Colis / palette', BarcodeRuleType::Package, '20', BarcodeEncoding::Any, null, 80],
            ['Alias fournisseur', BarcodeRuleType::Alias, '045', BarcodeEncoding::Any, 'supplier-alias', 90],
            ['Produit (EAN-13)', BarcodeRuleType::Product, '.*', BarcodeEncoding::Ean13, null, 100],
        ];

        $payload = [];
        foreach ($rules as [$name, $type, $pattern, $encoding, $alias, $sequence]) {
            $payload[] = [
                'barcode_nomenclature_id' => $nomenclatureId,
                'name' => $name,
                'rule_type' => $type->value,
                'pattern' => $pattern,
                'encoding' => $encoding->value,
                'alias' => $alias,
                'sequence' => $sequence,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
        }
        DB::table('barcode_rules')->insert($payload);

        DB::table('companies')->where('id', $this->companyId)
            ->update(['barcode_nomenclature_id' => $nomenclatureId]);
    }

    // ---------------------------------------------------------------- categories

    private function seedProductCategories(): void
    {
        // The `ledger_code` is the revenue account a category's sales post to in the accounting
        // export. French PCG 70x food/drink revenue accounts here, because the demo venue is French
        // and a blank column in an export teaches nobody anything.
        /** @var array<string, array{code: string, children: array<string, string>}> $tree */
        $tree = [
            'Cuisine' => ['code' => '7011', 'children' => [
                'Entrées froides' => '7011',
                'Entrées chaudes' => '7011',
                'Plats principaux' => '7011',
                'Desserts' => '7012',
            ]],
            'Bar' => ['code' => '7021', 'children' => [
                'Boissons sans alcool' => '7021',
                'Bières & cidres' => '7022',
                'Vins' => '7023',
                'Spiritueux & cocktails' => '7024',
            ]],
            'Divers' => ['code' => '7080', 'children' => [
                'Articles techniques' => '7080',
            ]],
        ];

        $sequence = 10;
        foreach ($tree as $root => $branch) {
            $rootId = (int) DB::table('product_categories')->insertGetId([
                'company_id' => $this->companyId,
                'parent_id' => null,
                'name' => $root,
                'path' => '/'.Demo::slug($root),
                'sequence' => $sequence,
                'ledger_code' => $branch['code'],
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $this->productCategories[$root] = $rootId;

            $childIndex = 0;
            foreach ($branch['children'] as $child => $ledgerCode) {
                $this->productCategories[$child] = (int) DB::table('product_categories')->insertGetId([
                    'company_id' => $this->companyId,
                    'parent_id' => $rootId,
                    'name' => $child,
                    'path' => '/'.Demo::slug($root).'/'.Demo::slug($child),
                    'sequence' => (++$childIndex) * 10,
                    'ledger_code' => $ledgerCode,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
            }
            $sequence += 10;
        }
    }

    private function seedPosCategories(): void
    {
        /** @var array<string, array{color:int, children: array<string, array{color:int, from:?string, to:?string, self:bool}>}> $tree */
        $tree = [
            'Cuisine' => [
                'color' => 4,
                'children' => [
                    self::CAT_STARTERS => ['color' => 1, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_MAINS => ['color' => 2, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_TAJINES => ['color' => 3, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_PIZZAS => ['color' => 5, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_BURGERS => ['color' => 6, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_DESSERTS => ['color' => 7, 'from' => null, 'to' => null, 'self' => true],
                ],
            ],
            'Bar' => [
                'color' => 8,
                'children' => [
                    self::CAT_HOT => ['color' => 9, 'from' => null, 'to' => null, 'self' => true],
                    self::CAT_COLD => ['color' => 10, 'from' => null, 'to' => null, 'self' => true],
                    // Alcohol is only offered from 11:00 and, for cocktails, from 16:00.
                    self::CAT_BEERS => ['color' => 11, 'from' => '11.00', 'to' => '23.50', 'self' => true],
                    self::CAT_WINES => ['color' => 12, 'from' => '11.00', 'to' => '23.50', 'self' => true],
                    self::CAT_COCKTAILS => ['color' => 2, 'from' => '16.00', 'to' => '23.50', 'self' => false],
                ],
            ],
            'Cartes' => [
                'color' => 3,
                'children' => [
                    self::CAT_MENUS => ['color' => 4, 'from' => null, 'to' => null, 'self' => true],
                ],
            ],
        ];

        $rootSequence = 10;
        foreach ($tree as $root => $definition) {
            $rootId = (int) DB::table('pos_categories')->insertGetId([
                'company_id' => $this->companyId,
                'parent_id' => null,
                'name' => $root,
                'path' => '/'.Demo::slug($root),
                'depth' => 0,
                'sequence' => $rootSequence,
                'color' => $definition['color'],
                'self_order_visible' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $this->posCategories[$root] = $rootId;

            $childSequence = 10;
            foreach ($definition['children'] as $name => $child) {
                $this->posCategories[$name] = (int) DB::table('pos_categories')->insertGetId([
                    'company_id' => $this->companyId,
                    'parent_id' => $rootId,
                    'name' => $name,
                    'path' => '/'.Demo::slug($root).'/'.Demo::slug($name),
                    'depth' => 1,
                    'sequence' => $childSequence,
                    'color' => $child['color'],
                    'hour_after' => $child['from'],
                    'hour_until' => $child['to'],
                    'self_order_visible' => $child['self'],
                    'active' => true,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
                $childSequence += 10;
            }
            $rootSequence += 10;
        }
    }

    private function seedTags(): void
    {
        /** @var list<array{0:string,1:int,2:bool,3:string}> $rows */
        $rows = [
            ['Végétarien', 1, true, 'Sans viande ni poisson.'],
            ['Vegan', 2, true, 'Sans produit d’origine animale.'],
            ['Sans gluten', 3, true, 'Préparé sans céréales contenant du gluten.'],
            ['Épicé', 4, true, 'Relevé — harissa ou piment.'],
            ['Fait maison', 5, true, 'Préparé sur place, chaque jour.'],
            ['Nouveauté', 6, true, 'Nouveau à la carte.'],
            ['Bio', 7, true, 'Issu de l’agriculture biologique.'],
            ['Spécialité marocaine', 8, true, 'La cuisine du Maghreb à la carte.'],
            ['Prix libre', 9, false, 'Le prix est saisi par le caissier au moment de la vente.'],
            ['Article technique', 10, false, 'Produit de service, jamais imprimé sur la carte.'],
        ];

        foreach ($rows as $index => [$name, $color, $visible, $description]) {
            $this->tags[$name] = (int) DB::table('product_tags')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $name,
                'color' => $color,
                'description' => $description,
                'visible_to_customers' => $visible,
                'sequence' => ($index + 1) * 10,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }
    }

    // ---------------------------------------------------------------- attributes

    private function seedAttributes(): void
    {
        /** @var array<string, array{display: AttributeDisplayType, create: AttributeCreateVariant, values: array<string, string>}> $definitions */
        $definitions = [
            // Drives real variants: each size is a different SKU with its own price.
            'Taille' => [
                'display' => AttributeDisplayType::Radio,
                'create' => AttributeCreateVariant::Always,
                'values' => ['Small (26 cm)' => '0.0000', 'Medium (33 cm)' => '2.5000', 'Large (40 cm)' => '5.0000'],
            ],
            'Format' => [
                'display' => AttributeDisplayType::Pills,
                'create' => AttributeCreateVariant::Always,
                'values' => ['25 cl' => '0.0000', '50 cl' => '2.5000'],
            ],
            // Rides on the order line, never creates a SKU and never moves the price.
            'Cuisson' => [
                'display' => AttributeDisplayType::Radio,
                'create' => AttributeCreateVariant::NoVariant,
                'values' => ['Bleu' => '0.0000', 'Saignant' => '0.0000', 'À point' => '0.0000', 'Bien cuit' => '0.0000'],
            ],
            'Accompagnement' => [
                'display' => AttributeDisplayType::Select,
                'create' => AttributeCreateVariant::NoVariant,
                'values' => ['Frites maison' => '0.0000', 'Salade verte' => '0.0000', 'Légumes de saison' => '0.0000', 'Riz parfumé' => '0.0000'],
            ],
            'Lait' => [
                'display' => AttributeDisplayType::Pills,
                'create' => AttributeCreateVariant::NoVariant,
                'values' => ['Lait entier' => '0.0000', 'Lait écrémé' => '0.0000', 'Sans lactose' => '0.5000', 'Boisson végétale' => '0.5000'],
            ],
        ];

        $sequence = 10;
        foreach ($definitions as $name => $definition) {
            $attributeId = (int) DB::table('product_attributes')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $name,
                'display_type' => $definition['display']->value,
                'create_variant' => $definition['create']->value,
                'sequence' => $sequence,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $values = [];
            $valueSequence = 10;
            foreach (array_keys($definition['values']) as $valueName) {
                $values[$valueName] = (int) DB::table('product_attribute_values')->insertGetId([
                    'product_attribute_id' => $attributeId,
                    'name' => $valueName,
                    'is_custom' => false,
                    'sequence' => $valueSequence,
                    'active' => true,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
                $valueSequence += 10;
            }

            $this->attributes[$name] = ['id' => $attributeId, 'values' => $values];
            $this->attributeMeta[$name] = $definition;
            $sequence += 10;
        }
    }

    // ------------------------------------------------------------------ products

    /**
     * The menu.
     *
     * @return list<array<string, mixed>>
     */
    private function menu(): array
    {
        $vat10 = TaxSeeder::VAT_ON_SITE;
        $vat20 = TaxSeeder::VAT_ALCOHOL;

        return [
            // ---------------------------------------------------------- Entrées
            ['name' => 'Soupe à l’oignon gratinée', 'cat' => self::CAT_STARTERS, 'price' => '8.5000', 'tax' => $vat10, 'icat' => 'Entrées chaudes', 'tags' => ['Fait maison'], 'cost' => '2.1000'],
            ['name' => 'Œuf mayonnaise du bistro', 'cat' => self::CAT_STARTERS, 'price' => '6.0000', 'tax' => $vat10, 'icat' => 'Entrées froides', 'tags' => ['Fait maison', 'Végétarien'], 'cost' => '1.2000'],
            ['name' => 'Salade de chèvre chaud', 'cat' => self::CAT_STARTERS, 'price' => '11.5000', 'tax' => $vat10, 'icat' => 'Entrées chaudes', 'tags' => ['Végétarien'], 'cost' => '3.4000'],
            ['name' => 'Terrine de campagne maison', 'cat' => self::CAT_STARTERS, 'price' => '9.0000', 'tax' => $vat10, 'icat' => 'Entrées froides', 'tags' => ['Fait maison'], 'cost' => '2.6000'],
            ['name' => 'Briouates au fromage (4 pièces)', 'cat' => self::CAT_STARTERS, 'price' => '9.5000', 'tax' => $vat10, 'icat' => 'Entrées chaudes', 'tags' => ['Spécialité marocaine', 'Végétarien'], 'cost' => '2.8000'],
            ['name' => 'Zaalouk d’aubergines', 'cat' => self::CAT_STARTERS, 'price' => '7.5000', 'tax' => $vat10, 'icat' => 'Entrées froides', 'tags' => ['Spécialité marocaine', 'Vegan', 'Sans gluten'], 'cost' => '1.9000'],
            ['name' => 'Velouté de potimarron', 'cat' => self::CAT_STARTERS, 'price' => '7.0000', 'tax' => $vat10, 'icat' => 'Entrées chaudes', 'tags' => ['Végétarien', 'Bio'], 'cost' => '1.5000'],
            ['name' => 'Assiette de charcuterie', 'cat' => self::CAT_STARTERS, 'price' => '13.5000', 'tax' => $vat10, 'icat' => 'Entrées froides', 'tags' => [], 'cost' => '5.2000'],
            ['name' => 'Salade composée au poids', 'cat' => self::CAT_STARTERS, 'price' => '18.0000', 'tax' => $vat10, 'icat' => 'Entrées froides', 'tags' => ['Végétarien'], 'cost' => '5.4000', 'uom' => 'kg', 'weigh' => true],

            // ------------------------------------------------------------ Plats
            ['name' => 'Steak frites, beurre maître d’hôtel', 'cat' => self::CAT_MAINS, 'price' => '21.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => [], 'cost' => '7.8000', 'attrs' => ['Cuisson', 'Accompagnement']],
            ['name' => 'Confit de canard, pommes sarladaises', 'cat' => self::CAT_MAINS, 'price' => '22.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Fait maison'], 'cost' => '8.1000'],
            ['name' => 'Magret de canard, sauce miel-citron', 'cat' => self::CAT_MAINS, 'price' => '24.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Nouveauté'], 'cost' => '9.3000', 'attrs' => ['Cuisson']],
            ['name' => 'Filet de bar, écrasé de pommes de terre', 'cat' => self::CAT_MAINS, 'price' => '23.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Sans gluten'], 'cost' => '8.7000'],
            ['name' => 'Blanquette de veau à l’ancienne', 'cat' => self::CAT_MAINS, 'price' => '20.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Fait maison'], 'cost' => '7.2000'],
            ['name' => 'Risotto aux champignons', 'cat' => self::CAT_MAINS, 'price' => '17.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Végétarien', 'Sans gluten'], 'cost' => '4.6000'],
            ['name' => 'Couscous royal', 'cat' => self::CAT_MAINS, 'price' => '23.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine'], 'cost' => '8.4000'],
            ['name' => 'Pastilla de volaille aux amandes', 'cat' => self::CAT_MAINS, 'price' => '19.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine', 'Fait maison'], 'cost' => '6.5000'],

            // ---------------------------------------------------------- Tajines
            ['name' => 'Tajine de poulet au citron confit', 'cat' => self::CAT_TAJINES, 'price' => '18.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine', 'Sans gluten'], 'cost' => '6.1000'],
            ['name' => 'Tajine d’agneau aux pruneaux', 'cat' => self::CAT_TAJINES, 'price' => '21.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine'], 'cost' => '7.9000'],
            ['name' => 'Tajine kefta aux œufs', 'cat' => self::CAT_TAJINES, 'price' => '17.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine', 'Épicé'], 'cost' => '5.8000'],
            ['name' => 'Tajine de légumes de saison', 'cat' => self::CAT_TAJINES, 'price' => '16.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Spécialité marocaine', 'Vegan', 'Sans gluten'], 'cost' => '4.2000'],

            // ----------------------------------------------------------- Pizzas
            ['name' => 'Pizza Margherita', 'cat' => self::CAT_PIZZAS, 'price' => '11.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Végétarien'], 'cost' => '3.0000', 'attrs' => ['Taille']],
            ['name' => 'Pizza Regina', 'cat' => self::CAT_PIZZAS, 'price' => '13.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => [], 'cost' => '4.1000', 'attrs' => ['Taille']],
            ['name' => 'Pizza Merguez-Harissa', 'cat' => self::CAT_PIZZAS, 'price' => '14.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Épicé', 'Spécialité marocaine'], 'cost' => '4.5000', 'attrs' => ['Taille']],
            ['name' => 'Pizza Chèvre-Miel', 'cat' => self::CAT_PIZZAS, 'price' => '13.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Végétarien'], 'cost' => '4.0000', 'attrs' => ['Taille']],
            ['name' => 'Pizza Quatre Fromages', 'cat' => self::CAT_PIZZAS, 'price' => '14.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Végétarien'], 'cost' => '4.8000', 'attrs' => ['Taille']],

            // ---------------------------------------------------------- Burgers
            ['name' => 'Burger du Bistro', 'cat' => self::CAT_BURGERS, 'price' => '16.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Fait maison'], 'cost' => '5.6000', 'attrs' => ['Cuisson', 'Accompagnement']],
            ['name' => 'Cheeseburger classique', 'cat' => self::CAT_BURGERS, 'price' => '14.5000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => [], 'cost' => '4.7000', 'attrs' => ['Cuisson']],
            ['name' => 'Burger végétarien', 'cat' => self::CAT_BURGERS, 'price' => '15.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Végétarien'], 'cost' => '4.4000', 'attrs' => ['Accompagnement']],
            ['name' => 'Burger merguez-harissa', 'cat' => self::CAT_BURGERS, 'price' => '16.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Épicé'], 'cost' => '5.2000', 'attrs' => ['Accompagnement']],

            // --------------------------------------------------------- Desserts
            ['name' => 'Crème brûlée à la vanille', 'cat' => self::CAT_DESSERTS, 'price' => '8.0000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Fait maison', 'Végétarien'], 'cost' => '1.7000'],
            ['name' => 'Tarte Tatin, crème fraîche', 'cat' => self::CAT_DESSERTS, 'price' => '8.5000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Fait maison', 'Végétarien'], 'cost' => '1.9000'],
            ['name' => 'Fondant au chocolat', 'cat' => self::CAT_DESSERTS, 'price' => '8.5000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Végétarien'], 'cost' => '1.8000'],
            ['name' => 'Pastilla au lait et amandes', 'cat' => self::CAT_DESSERTS, 'price' => '9.0000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Spécialité marocaine'], 'cost' => '2.4000'],
            ['name' => 'Salade d’oranges à la cannelle', 'cat' => self::CAT_DESSERTS, 'price' => '6.5000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Vegan', 'Sans gluten'], 'cost' => '1.1000'],
            ['name' => 'Profiteroles au chocolat chaud', 'cat' => self::CAT_DESSERTS, 'price' => '9.0000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Végétarien'], 'cost' => '2.2000'],
            ['name' => 'Assiette de fromages affinés au poids', 'cat' => self::CAT_DESSERTS, 'price' => '32.0000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Végétarien'], 'cost' => '14.0000', 'uom' => 'kg', 'weigh' => true],
            ['name' => 'Loukoums assortis au poids', 'cat' => self::CAT_DESSERTS, 'price' => '26.0000', 'tax' => $vat10, 'icat' => 'Desserts', 'tags' => ['Spécialité marocaine', 'Vegan'], 'cost' => '9.5000', 'uom' => 'kg', 'weigh' => true],

            // -------------------------------------------------- Boissons chaudes
            ['name' => 'Café expresso', 'cat' => self::CAT_HOT, 'price' => '2.2000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Bio'], 'cost' => '0.3000', 'barcode' => '380000000001'],
            ['name' => 'Café allongé', 'cat' => self::CAT_HOT, 'price' => '2.4000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Bio'], 'cost' => '0.3200', 'barcode' => '380000000002', 'attrs' => ['Lait']],
            ['name' => 'Cappuccino', 'cat' => self::CAT_HOT, 'price' => '3.8000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => [], 'cost' => '0.5500', 'barcode' => '380000000003', 'attrs' => ['Lait']],
            ['name' => 'Thé à la menthe', 'cat' => self::CAT_HOT, 'price' => '4.5000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Spécialité marocaine', 'Vegan'], 'cost' => '0.6000', 'barcode' => '380000000004'],
            ['name' => 'Chocolat chaud maison', 'cat' => self::CAT_HOT, 'price' => '4.2000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Fait maison'], 'cost' => '0.7000', 'barcode' => '380000000005'],
            ['name' => 'Infusion verveine-menthe', 'cat' => self::CAT_HOT, 'price' => '3.5000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Bio', 'Vegan'], 'cost' => '0.4000', 'barcode' => '380000000006'],

            // ------------------------------------------------- Boissons fraîches
            ['name' => 'Eau minérale plate 50 cl', 'cat' => self::CAT_COLD, 'price' => '3.0000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => [], 'cost' => '0.4000', 'barcode' => '380000000010'],
            ['name' => 'Eau pétillante 50 cl', 'cat' => self::CAT_COLD, 'price' => '3.2000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => [], 'cost' => '0.4500', 'barcode' => '380000000011'],
            ['name' => 'Coca-Cola 33 cl', 'cat' => self::CAT_COLD, 'price' => '3.5000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => [], 'cost' => '0.6000', 'barcode' => '380000000012'],
            ['name' => 'Limonade artisanale 33 cl', 'cat' => self::CAT_COLD, 'price' => '4.0000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Fait maison'], 'cost' => '0.8000', 'barcode' => '380000000013'],
            ['name' => 'Jus d’orange pressé', 'cat' => self::CAT_COLD, 'price' => '4.5000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Fait maison', 'Vegan'], 'cost' => '1.1000'],
            ['name' => 'Thé glacé maison 33 cl', 'cat' => self::CAT_COLD, 'price' => '4.0000', 'tax' => $vat10, 'icat' => 'Boissons sans alcool', 'tags' => ['Fait maison'], 'cost' => '0.7000', 'barcode' => '380000000014'],
            // Packaged, sold to go: the composite "eco-contribution + 5,5 %" tax.
            ['name' => 'Bouteille d’eau 1,5 L à emporter', 'cat' => self::CAT_COLD, 'price' => '2.5000', 'tax' => TaxSeeder::TAKEAWAY_PACKAGED, 'icat' => 'Boissons sans alcool', 'tags' => [], 'cost' => '0.5000', 'barcode' => '380000000015'],

            // ----------------------------------------------------------- Bières
            ['name' => 'Bière pression de la maison', 'cat' => self::CAT_BEERS, 'price' => '4.5000', 'tax' => $vat20, 'icat' => 'Bières & cidres', 'tags' => [], 'cost' => '1.1000', 'attrs' => ['Format']],
            ['name' => 'Chouffe blonde 33 cl', 'cat' => self::CAT_BEERS, 'price' => '6.5000', 'tax' => $vat20, 'icat' => 'Bières & cidres', 'tags' => [], 'cost' => '1.9000', 'barcode' => '380000000020', 'pack' => true],
            ['name' => 'IPA artisanale 33 cl', 'cat' => self::CAT_BEERS, 'price' => '6.9000', 'tax' => $vat20, 'icat' => 'Bières & cidres', 'tags' => ['Nouveauté'], 'cost' => '2.1000', 'barcode' => '380000000021', 'pack' => true],
            ['name' => 'Bière blanche 33 cl', 'cat' => self::CAT_BEERS, 'price' => '6.0000', 'tax' => $vat20, 'icat' => 'Bières & cidres', 'tags' => [], 'cost' => '1.8000', 'barcode' => '380000000022', 'pack' => true],
            ['name' => 'Bière sans alcool 33 cl', 'cat' => self::CAT_BEERS, 'price' => '5.0000', 'tax' => $vat10, 'icat' => 'Bières & cidres', 'tags' => [], 'cost' => '1.4000', 'barcode' => '380000000023', 'pack' => true],

            // ------------------------------------------------------------- Vins
            ['name' => 'Côtes du Rhône — verre 12 cl', 'cat' => self::CAT_WINES, 'price' => '5.5000', 'tax' => $vat20, 'icat' => 'Vins', 'tags' => [], 'cost' => '1.3000'],
            ['name' => 'Côtes du Rhône — bouteille 75 cl', 'cat' => self::CAT_WINES, 'price' => '26.0000', 'tax' => $vat20, 'icat' => 'Vins', 'tags' => [], 'cost' => '8.0000', 'barcode' => '380000000030', 'pack' => true],
            ['name' => 'Chablis — bouteille 75 cl', 'cat' => self::CAT_WINES, 'price' => '34.0000', 'tax' => $vat20, 'icat' => 'Vins', 'tags' => [], 'cost' => '12.5000', 'barcode' => '380000000031', 'pack' => true],
            ['name' => 'Rosé de Provence — bouteille 75 cl', 'cat' => self::CAT_WINES, 'price' => '28.0000', 'tax' => $vat20, 'icat' => 'Vins', 'tags' => ['Bio'], 'cost' => '9.2000', 'barcode' => '380000000032', 'pack' => true],
            ['name' => 'Vin gris de Boulaouane 75 cl', 'cat' => self::CAT_WINES, 'price' => '24.0000', 'tax' => $vat20, 'icat' => 'Vins', 'tags' => ['Spécialité marocaine'], 'cost' => '7.4000', 'barcode' => '380000000033', 'pack' => true],

            // -------------------------------------------------------- Cocktails
            ['name' => 'Mojito', 'cat' => self::CAT_COCKTAILS, 'price' => '11.0000', 'tax' => $vat20, 'icat' => 'Spiritueux & cocktails', 'tags' => [], 'cost' => '2.6000', 'self' => false],
            ['name' => 'Spritz Apérol', 'cat' => self::CAT_COCKTAILS, 'price' => '10.0000', 'tax' => $vat20, 'icat' => 'Spiritueux & cocktails', 'tags' => [], 'cost' => '2.4000', 'self' => false],
            ['name' => 'Negroni', 'cat' => self::CAT_COCKTAILS, 'price' => '12.0000', 'tax' => $vat20, 'icat' => 'Spiritueux & cocktails', 'tags' => [], 'cost' => '3.0000', 'self' => false],
            ['name' => 'Kir royal', 'cat' => self::CAT_COCKTAILS, 'price' => '9.5000', 'tax' => $vat20, 'icat' => 'Spiritueux & cocktails', 'tags' => [], 'cost' => '2.2000', 'self' => false],
            ['name' => 'Cocktail du chef (prix libre)', 'cat' => self::CAT_COCKTAILS, 'price' => '0.0000', 'tax' => $vat20, 'icat' => 'Spiritueux & cocktails', 'tags' => ['Prix libre'], 'cost' => '2.5000', 'self' => false, 'open' => true],

            // ------------------------------------------------------- ardoise/etc
            ['name' => 'Suggestion de l’ardoise', 'cat' => self::CAT_MAINS, 'price' => '0.0000', 'tax' => $vat10, 'icat' => 'Plats principaux', 'tags' => ['Prix libre', 'Fait maison'], 'cost' => '0.0000', 'self' => false, 'open' => true],
        ];
    }

    private function seedProducts(): void
    {
        $sequence = 0;
        foreach ($this->menu() as $definition) {
            $this->createProduct($definition, $sequence += 10);
        }

        $this->createSpecialProducts();
    }

    /** @param  array<string, mixed>  $d */
    private function createProduct(array $d, int $sequence): int
    {
        /** @var string $name */
        $name = $d['name'];
        /** @var list<string> $attrs */
        $attrs = $d['attrs'] ?? [];
        $slug = Demo::slug($name);
        $barcode = isset($d['barcode']) ? Demo::ean13((string) $d['barcode']) : null;
        $isOpenPrice = (bool) ($d['open'] ?? false);

        $productId = (int) DB::table('products')->insertGetId([
            'uuid' => Demo::uuid('product:'.$slug),
            'company_id' => $this->companyId,
            'name' => $name,
            'product_category_id' => $this->productCategories[$d['icat']] ?? null,
            'product_type' => ProductType::Consumable->value,
            'default_code' => strtoupper(substr($slug, 0, 24)),
            'barcode' => $attrs === [] ? $barcode : null,
            'uom_id' => $this->uoms[$d['uom'] ?? 'Unité(s)'],
            'list_price' => $d['price'],
            'standard_price' => $d['cost'],
            'available_in_pos' => true,
            'self_order_available' => (bool) ($d['self'] ?? true),
            'to_weight' => (bool) ($d['weigh'] ?? false),
            'track_stock' => isset($d['pack']),
            'allow_negative_stock' => true,
            'is_special' => false,
            'special_kind' => SpecialKind::None->value,
            'description_sale' => $isOpenPrice ? 'Prix saisi en caisse.' : null,
            'public_description' => $name,
            'color' => ($sequence / 10) % 12,
            'pos_sequence' => $sequence,
            'is_favorite' => in_array($name, [
                'Café expresso', 'Bière pression de la maison', 'Steak frites, beurre maître d’hôtel',
                'Tajine de poulet au citron confit', 'Crème brûlée à la vanille',
            ], true),
            'has_image' => false,
            'attribute_count' => count($attrs),
            'combo_count' => 0,
            'sale_ok' => true,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        $this->productIds[$name] = $productId;

        DB::table('pos_category_product')->insert([
            'pos_category_id' => $this->posCategories[$d['cat']],
            'product_id' => $productId,
            'sequence' => $sequence,
        ]);

        DB::table('product_tax')->insert([
            'product_id' => $productId,
            'tax_id' => $this->taxes[$d['tax']],
        ]);

        foreach ((array) ($d['tags'] ?? []) as $tag) {
            DB::table('product_tag_product')->insert([
                'product_tag_id' => $this->tags[$tag],
                'product_id' => $productId,
            ]);
        }

        $this->createVariants($productId, $name, $slug, $d, $attrs, $barcode);

        return $productId;
    }

    /**
     * @param  array<string, mixed>  $d
     * @param  list<string>  $attrs
     */
    private function createVariants(int $productId, string $name, string $slug, array $d, array $attrs, ?string $barcode): void
    {
        /** @var list<list<array{name: string, lineValueId: int, extra: string}>> $variantAxes */
        $variantAxes = [];
        $lineSequence = 10;

        foreach ($attrs as $attributeName) {
            $attribute = $this->attributes[$attributeName];
            $meta = $this->attributeMeta[$attributeName];

            $lineId = (int) DB::table('product_attribute_lines')->insertGetId([
                'product_id' => $productId,
                'product_attribute_id' => $attribute['id'],
                'is_required' => $meta['create'] === AttributeCreateVariant::Always,
                'sequence' => $lineSequence,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $lineSequence += 10;

            $axis = [];
            $valueSequence = 10;
            foreach ($meta['values'] as $valueName => $extra) {
                $lineValueId = (int) DB::table('product_attribute_line_values')->insertGetId([
                    'product_attribute_line_id' => $lineId,
                    'product_attribute_value_id' => $attribute['values'][$valueName],
                    'product_id' => $productId,
                    'price_extra' => $extra,
                    'sequence' => $valueSequence,
                    'active' => true,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
                $valueSequence += 10;

                $axis[] = ['name' => $valueName, 'lineValueId' => $lineValueId, 'extra' => $extra];
            }

            if ($meta['create'] === AttributeCreateVariant::Always) {
                $variantAxes[] = $axis;
            }
        }

        // Cartesian product of the variant-creating axes; no axis ⇒ one plain variant.
        /** @var list<list<array{name: string, lineValueId: int, extra: string}>> $combinations */
        $combinations = [[]];
        foreach ($variantAxes as $axis) {
            $next = [];
            foreach ($combinations as $prefix) {
                foreach ($axis as $value) {
                    $next[] = [...$prefix, $value];
                }
            }
            $combinations = $next;
        }

        foreach ($combinations as $index => $combination) {
            $suffix = $combination === []
                ? null
                : implode(', ', array_column($combination, 'name'));
            $displayName = $suffix === null ? $name : $name.' ('.$suffix.')';

            $extra = '0.0000';
            foreach ($combination as $value) {
                $extra = number_format((float) $extra + (float) $value['extra'], 4, '.', '');
            }

            $variantBarcode = $combination === []
                ? $barcode
                : ($barcode === null ? null : Demo::ean13(substr((string) $d['barcode'], 0, 11).(string) ($index + 1)));

            $variantId = (int) DB::table('product_variants')->insertGetId([
                'uuid' => Demo::uuid('variant:'.$slug.':'.$index),
                'product_id' => $productId,
                'company_id' => $this->companyId,
                'name_suffix' => $suffix,
                'display_name' => $displayName,
                'default_code' => strtoupper(substr($slug, 0, 20)).'-'.str_pad((string) ($index + 1), 2, '0', STR_PAD_LEFT),
                'barcode' => $variantBarcode,
                'price_extra' => $extra,
                'list_price' => null,
                'standard_price' => $d['cost'],
                'on_hand_qty' => isset($d['pack']) ? '120.000' : '0.000',
                'self_order_available' => (bool) ($d['self'] ?? true),
                'is_active_combination' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $this->variantIds[$displayName] = $variantId;

            foreach ($combination as $value) {
                DB::table('product_variant_attribute_value')->insert([
                    'product_variant_id' => $variantId,
                    'product_attribute_line_value_id' => $value['lineValueId'],
                ]);
            }
        }
    }

    /** Technical products the register needs: tip, global discount, loyalty reward, deposit. */
    private function createSpecialProducts(): void
    {
        /** @var list<array{0:string,1:SpecialKind,2:string}> $rows */
        $rows = [
            ['Pourboire', SpecialKind::Tip, TaxSeeder::VAT_EXEMPT],
            ['Remise globale', SpecialKind::GlobalDiscount, TaxSeeder::VAT_EXEMPT],
            ['Récompense fidélité', SpecialKind::LoyaltyReward, TaxSeeder::VAT_EXEMPT],
            ['Consigne emballage', SpecialKind::Deposit, TaxSeeder::VAT_EXEMPT],
        ];

        $sequence = 9000;
        foreach ($rows as [$name, $kind, $taxCode]) {
            $slug = Demo::slug($name);

            $productId = (int) DB::table('products')->insertGetId([
                'uuid' => Demo::uuid('product:'.$slug),
                'company_id' => $this->companyId,
                'name' => $name,
                'product_category_id' => $this->productCategories['Articles techniques'],
                'product_type' => ProductType::Service->value,
                'default_code' => strtoupper($slug),
                'barcode' => null,
                'uom_id' => $this->uoms['Unité(s)'],
                'list_price' => '0.0000',
                'standard_price' => '0.0000',
                'available_in_pos' => false,
                'self_order_available' => false,
                'to_weight' => false,
                'track_stock' => false,
                'allow_negative_stock' => true,
                'is_special' => true,
                'special_kind' => $kind->value,
                'internal_note' => 'Produit technique — ne pas afficher à la carte.',
                'color' => 0,
                'pos_sequence' => $sequence += 10,
                'has_image' => false,
                'attribute_count' => 0,
                'combo_count' => 0,
                'sale_ok' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $this->productIds[$name] = $productId;

            DB::table('product_tax')->insert([
                'product_id' => $productId,
                'tax_id' => $this->taxes[$taxCode],
            ]);
            DB::table('product_tag_product')->insert([
                'product_tag_id' => $this->tags['Article technique'],
                'product_id' => $productId,
            ]);

            $this->variantIds[$name] = (int) DB::table('product_variants')->insertGetId([
                'uuid' => Demo::uuid('variant:'.$slug.':0'),
                'product_id' => $productId,
                'company_id' => $this->companyId,
                'name_suffix' => null,
                'display_name' => $name,
                'default_code' => strtoupper($slug).'-01',
                'barcode' => null,
                'price_extra' => '0.0000',
                'standard_price' => '0.0000',
                'on_hand_qty' => '0.000',
                'self_order_available' => false,
                'is_active_combination' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
        }
    }

    // -------------------------------------------------------------------- combos

    private function seedCombos(): void
    {
        /** @var array<string, array{base: string, free: int, max: int, items: array<string, string>}> $choiceSets */
        $choiceSets = [
            'Entrée du menu' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Soupe à l’oignon gratinée' => '0.0000',
                'Œuf mayonnaise du bistro' => '0.0000',
                'Zaalouk d’aubergines' => '0.0000',
                'Velouté de potimarron' => '0.0000',
                'Salade de chèvre chaud' => '2.0000',
            ]],
            'Plat du menu' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Blanquette de veau à l’ancienne' => '0.0000',
                'Risotto aux champignons' => '0.0000',
                'Tajine de poulet au citron confit' => '0.0000',
                'Steak frites, beurre maître d’hôtel' => '3.0000',
                'Couscous royal' => '4.0000',
            ]],
            'Dessert du menu' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Crème brûlée à la vanille' => '0.0000',
                'Tarte Tatin, crème fraîche' => '0.0000',
                'Salade d’oranges à la cannelle' => '0.0000',
                'Fondant au chocolat' => '1.0000',
            ]],
            'Plat enfant' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Cheeseburger classique' => '0.0000',
                'Pizza Margherita (Small (26 cm))' => '0.0000',
                'Tajine de légumes de saison' => '0.0000',
            ]],
            'Boisson enfant' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Limonade artisanale 33 cl' => '0.0000',
                'Jus d’orange pressé' => '0.0000',
                'Eau minérale plate 50 cl' => '0.0000',
            ]],
            'Dessert enfant' => ['base' => '0.0000', 'free' => 1, 'max' => 1, 'items' => [
                'Fondant au chocolat' => '0.0000',
                'Salade d’oranges à la cannelle' => '0.0000',
            ]],
            'Boisson de la formule' => ['base' => '0.0000', 'free' => 1, 'max' => 2, 'items' => [
                'Café expresso' => '0.0000',
                'Eau minérale plate 50 cl' => '0.0000',
                'Coca-Cola 33 cl' => '0.5000',
                'Bière pression de la maison (25 cl)' => '1.5000',
            ]],
        ];

        /** @var array<string, int> $comboIds */
        $comboIds = [];
        $sequence = 10;
        foreach ($choiceSets as $comboName => $set) {
            $comboId = (int) DB::table('combos')->insertGetId([
                'company_id' => $this->companyId,
                'name' => $comboName,
                'base_price' => $set['base'],
                'qty_free' => $set['free'],
                'qty_max' => $set['max'],
                'sequence' => $sequence,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $comboIds[$comboName] = $comboId;

            $itemSequence = 10;
            foreach ($set['items'] as $variantName => $extra) {
                DB::table('combo_items')->insert([
                    'combo_id' => $comboId,
                    'product_variant_id' => $this->variantIds[$variantName],
                    'extra_price' => $extra,
                    'sequence' => $itemSequence,
                    'active' => true,
                    'created_at' => $this->now,
                    'updated_at' => $this->now,
                ]);
                $itemSequence += 10;
            }
            $sequence += 10;
        }

        /** @var array<string, array{price: string, cost: string, combos: list<string>, self: bool}> $menus */
        $menus = [
            'Menu du Jour' => [
                'price' => '24.5000', 'cost' => '8.9000', 'self' => true,
                'combos' => ['Entrée du menu', 'Plat du menu', 'Dessert du menu'],
            ],
            'Menu Enfant' => [
                'price' => '11.5000', 'cost' => '3.6000', 'self' => true,
                'combos' => ['Plat enfant', 'Boisson enfant', 'Dessert enfant'],
            ],
            'Formule Midi' => [
                'price' => '18.9000', 'cost' => '6.4000', 'self' => false,
                'combos' => ['Plat du menu', 'Boisson de la formule'],
            ],
        ];

        $sequence = 5;
        foreach ($menus as $name => $menu) {
            $slug = Demo::slug($name);

            $productId = (int) DB::table('products')->insertGetId([
                'uuid' => Demo::uuid('product:'.$slug),
                'company_id' => $this->companyId,
                'name' => $name,
                'product_category_id' => $this->productCategories['Plats principaux'],
                'product_type' => ProductType::Combo->value,
                'default_code' => strtoupper($slug),
                'barcode' => null,
                'uom_id' => $this->uoms['Unité(s)'],
                'list_price' => $menu['price'],
                'standard_price' => $menu['cost'],
                'available_in_pos' => true,
                'self_order_available' => $menu['self'],
                'to_weight' => false,
                'track_stock' => false,
                'allow_negative_stock' => true,
                'is_special' => false,
                'special_kind' => SpecialKind::None->value,
                'public_description' => $name.' — servi midi et soir.',
                'color' => 3,
                'pos_sequence' => $sequence,
                'is_favorite' => true,
                'has_image' => false,
                'attribute_count' => 0,
                'combo_count' => count($menu['combos']),
                'sale_ok' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);
            $this->productIds[$name] = $productId;

            DB::table('pos_category_product')->insert([
                'pos_category_id' => $this->posCategories[self::CAT_MENUS],
                'product_id' => $productId,
                'sequence' => $sequence,
            ]);
            DB::table('product_tax')->insert([
                'product_id' => $productId,
                'tax_id' => $this->taxes[TaxSeeder::VAT_ON_SITE],
            ]);

            foreach ($menu['combos'] as $comboIndex => $comboName) {
                DB::table('combo_product')->insert([
                    'product_id' => $productId,
                    'combo_id' => $comboIds[$comboName],
                    'sequence' => ($comboIndex + 1) * 10,
                ]);
            }

            $this->variantIds[$name] = (int) DB::table('product_variants')->insertGetId([
                'uuid' => Demo::uuid('variant:'.$slug.':0'),
                'product_id' => $productId,
                'company_id' => $this->companyId,
                'name_suffix' => null,
                'display_name' => $name,
                'default_code' => strtoupper($slug).'-01',
                'barcode' => null,
                'price_extra' => '0.0000',
                'standard_price' => $menu['cost'],
                'on_hand_qty' => '0.000',
                'self_order_available' => $menu['self'],
                'is_active_combination' => true,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ]);

            $sequence += 5;
        }
    }

    // -------------------------------------------------------- upsell & packaging

    private function seedOptionalProducts(): void
    {
        /** @var array<string, list<string>> $upsells */
        $upsells = [
            'Steak frites, beurre maître d’hôtel' => ['Côtes du Rhône — verre 12 cl', 'Crème brûlée à la vanille'],
            'Burger du Bistro' => ['Bière pression de la maison', 'Fondant au chocolat'],
            'Tajine de poulet au citron confit' => ['Thé à la menthe', 'Pastilla au lait et amandes'],
            'Pizza Margherita' => ['Bière pression de la maison', 'Salade d’oranges à la cannelle'],
            'Couscous royal' => ['Vin gris de Boulaouane 75 cl', 'Loukoums assortis au poids'],
            'Menu du Jour' => ['Café expresso', 'Côtes du Rhône — verre 12 cl'],
        ];

        foreach ($upsells as $product => $options) {
            foreach ($options as $index => $option) {
                DB::table('product_optional_products')->insert([
                    'product_id' => $this->productIds[$product],
                    'optional_product_id' => $this->productIds[$option],
                    'sequence' => ($index + 1) * 10,
                ]);
            }
        }
    }

    private function seedPackagings(): void
    {
        $packable = [
            'Chouffe blonde 33 cl' => '380000100020',
            'IPA artisanale 33 cl' => '380000100021',
            'Bière blanche 33 cl' => '380000100022',
            'Bière sans alcool 33 cl' => '380000100023',
            'Côtes du Rhône — bouteille 75 cl' => '380000100030',
            'Chablis — bouteille 75 cl' => '380000100031',
            'Rosé de Provence — bouteille 75 cl' => '380000100032',
            'Vin gris de Boulaouane 75 cl' => '380000100033',
        ];

        $payload = [];
        foreach ($packable as $variantName => $base) {
            $variantId = $this->variantIds[$variantName];

            $payload[] = [
                'product_variant_id' => $variantId,
                'uom_id' => $this->uoms['Pack de 6'],
                'name' => 'Pack de 6',
                'qty' => '6.000',
                'barcode' => Demo::ean13(substr($base, 0, 11).'6'),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
            $payload[] = [
                'product_variant_id' => $variantId,
                'uom_id' => $this->uoms['Carton de 24'],
                'name' => 'Carton de 24',
                'qty' => '24.000',
                'barcode' => Demo::ean13(substr($base, 0, 11).'7'),
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ];
        }
        DB::table('product_packagings')->insert($payload);
    }

    /**
     * A variant with at least one `product_variant_tax` row REPLACES its
     * template's taxes. The large pizzas only leave the kitchen in a box, so
     * they carry the composite "eco-contribution + 5,5 %" tax instead of the
     * template's on-site 10 % — which is also what exercises the group-tax and
     * fixed-amount branches of the engine on real order lines.
     */
    private function seedVariantTaxOverrides(): void
    {
        $largePizzas = array_filter(
            $this->variantIds,
            static fn (string $name): bool => str_starts_with($name, 'Pizza ') && str_contains($name, 'Large'),
            ARRAY_FILTER_USE_KEY,
        );

        $payload = [];
        foreach ($largePizzas as $variantId) {
            $payload[] = [
                'product_variant_id' => $variantId,
                'tax_id' => $this->taxes[TaxSeeder::TAKEAWAY_PACKAGED],
            ];
        }

        if ($payload !== []) {
            DB::table('product_variant_tax')->insert($payload);
        }
    }

    /**
     * The schema has no `is_open_price` column; open-price products are declared
     * by the "Prix libre" tag and mirrored into a setting so the register can
     * resolve them without a join at bootstrap time.
     */
    private function seedOpenPriceSetting(): void
    {
        $ids = DB::table('product_tag_product')
            ->where('product_tag_id', $this->tags['Prix libre'])
            ->pluck('product_id')
            ->map(static fn ($value): int => (int) $value)
            ->values()
            ->all();

        DB::table('settings')->insert([
            'company_id' => $this->companyId,
            'key' => 'pos.open_price_product_ids',
            'value' => json_encode($ids, JSON_THROW_ON_ERROR),
            'value_type' => SettingValueType::Json->value,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);
    }
}
