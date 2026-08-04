<?php

declare(strict_types=1);

/**
 * Domain 2 — Catalog (spec 01-schema §2.B).
 *
 * Tables created here:
 *   uom_categories, uoms, product_categories, pos_categories, product_tags,
 *   products, product_variants, product_packagings,
 *   pos_category_product, product_tag_product, product_optional_products,
 *   product_attributes, product_attribute_values, product_attribute_lines,
 *   product_attribute_line_values, product_variant_attribute_value,
 *   product_attribute_exclusions,
 *   combos, combo_items, combo_product,
 *   barcode_nomenclatures, barcode_rules
 *
 * `product_tax` / `product_variant_tax` live with the pricing domain (they need `taxes`).
 */

use App\Enums\AttributeCreateVariant;
use App\Enums\AttributeDisplayType;
use App\Enums\BarcodeEncoding;
use App\Enums\BarcodeRuleType;
use App\Enums\ProductType;
use App\Enums\SpecialKind;
use App\Enums\UomType;
use App\Enums\UpcEanConversion;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('uom_categories', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 64);
            $table->timestamps();
        });

        Schema::create('uoms', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('uom_category_id')->constrained('uom_categories')->restrictOnDelete();
            $table->string('name', 48);
            $table->string('uom_type', 16)->default(UomType::Reference->value);
            $table->decimal('factor', 24, 12)->default(1);
            $table->decimal('rounding', 12, 6)->default(0.01);
            $table->boolean('is_pos_groupable')->default(true);
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('uoms', ['uom_type' => UomType::values()]);

        // Internal/reporting tree.
        Schema::create('product_categories', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('parent_id')->nullable()->constrained('product_categories')->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('path', 512)->index();
            $table->integer('sequence')->default(10);
            // Revenue account this category's sales post to, echoed into the accounting export.
            // Free-form so it fits whatever chart of accounts the site keeps; nullable because an
            // uncategorised product must still export rather than block the period.
            $table->string('ledger_code', 32)->nullable();
            $table->timestamps();
        });

        // The register's browsing tree.
        Schema::create('pos_categories', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('parent_id')->nullable()->constrained('pos_categories')->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('path', 512)->index();
            $table->unsignedTinyInteger('depth')->default(0);
            $table->integer('sequence')->default(10)->index();
            $table->unsignedTinyInteger('color')->default(0);
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->decimal('hour_after', 5, 2)->nullable();
            $table->decimal('hour_until', 5, 2)->nullable();
            $table->boolean('self_order_visible')->default(true);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();

            $table->unique(['company_id', 'parent_id', 'name']);
        });

        $this->applyRawChecks('pos_categories', [
            'pos_categories_hour_window_check' => '(hour_after IS NULL OR hour_until IS NULL OR hour_until >= hour_after)',
        ]);

        Schema::create('product_tags', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->unsignedTinyInteger('color')->default(0);
            $table->text('description')->nullable();
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->boolean('visible_to_customers')->default(true)->index();
            $table->integer('sequence')->default(10);
            $table->timestamps();

            $table->unique(['company_id', 'name']);
        });

        // Product template — the sellable concept.
        Schema::create('products', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 200)->index();
            $table->foreignId('product_category_id')->nullable()->constrained('product_categories')->nullOnDelete();
            $table->string('product_type', 16)->default(ProductType::Consumable->value);
            $table->string('default_code', 64)->nullable()->index();
            $table->string('barcode', 64)->nullable();
            $table->foreignId('uom_id')->constrained('uoms')->restrictOnDelete();
            $table->decimal('list_price', 16, 4)->default(0);
            $table->decimal('standard_price', 16, 4)->default(0);
            $table->boolean('available_in_pos')->default(true)->index();
            $table->boolean('self_order_available')->default(true)->index();
            $table->boolean('to_weight')->default(false);
            $table->boolean('track_stock')->default(false);
            $table->boolean('allow_negative_stock')->default(true);
            $table->boolean('is_special')->default(false)->index();
            $table->string('special_kind', 24)->default(SpecialKind::None->value);
            $table->text('description_sale')->nullable();
            $table->text('public_description')->nullable();
            $table->text('internal_note')->nullable();
            $table->unsignedTinyInteger('color')->default(0);
            $table->integer('pos_sequence')->default(0)->index();
            $table->boolean('is_favorite')->default(false)->index();
            $table->timestamp('last_sold_at')->nullable()->index();
            $table->unsignedInteger('sale_count')->default(0);
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->boolean('has_image')->default(false);
            $table->unsignedTinyInteger('attribute_count')->default(0);
            $table->unsignedTinyInteger('combo_count')->default(0);
            $table->boolean('sale_ok')->default(true);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['company_id', 'barcode']);
            $table->index(['company_id', 'available_in_pos', 'active'], 'products_pos_bootstrap_index');
            $table->index(['company_id', 'self_order_available', 'active'], 'products_self_bootstrap_index');
        });

        $this->applyChecks('products', [
            'product_type' => ProductType::values(),
            'special_kind' => SpecialKind::values(),
        ]);

        // The actually-sold SKU.
        Schema::create('product_variants', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name_suffix', 160)->nullable();
            $table->string('display_name', 255)->index();
            $table->string('default_code', 64)->nullable()->index();
            $table->string('barcode', 64)->nullable();
            $table->decimal('price_extra', 16, 4)->default(0);
            $table->decimal('list_price', 16, 4)->nullable();
            $table->decimal('standard_price', 16, 4)->default(0);
            $table->decimal('on_hand_qty', 16, 3)->default(0);
            $table->boolean('self_order_available')->default(true)->index();
            $table->boolean('is_active_combination')->default(true)->index();
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['company_id', 'barcode']);
        });

        Schema::create('product_packagings', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_variant_id')->constrained('product_variants')->cascadeOnDelete();
            $table->foreignId('uom_id')->constrained('uoms')->restrictOnDelete();
            $table->string('name', 64)->nullable();
            $table->decimal('qty', 16, 3)->default(1);
            $table->string('barcode', 64)->index();
            $table->timestamps();
        });

        Schema::create('pos_category_product', function (Blueprint $table): void {
            $table->foreignId('pos_category_id')->constrained('pos_categories')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['pos_category_id', 'product_id']);
        });

        Schema::create('product_tag_product', function (Blueprint $table): void {
            $table->foreignId('product_tag_id')->constrained('product_tags')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();

            $table->primary(['product_tag_id', 'product_id']);
        });

        // Upsell / cross-sell (self m2m).
        Schema::create('product_optional_products', function (Blueprint $table): void {
            $table->foreignId('product_id')->constrained('products')->cascadeOnDelete();
            $table->foreignId('optional_product_id')->constrained('products')->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['product_id', 'optional_product_id'], 'product_optional_products_primary');
        });

        Schema::create('product_attributes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('display_type', 16)->default(AttributeDisplayType::Radio->value);
            $table->string('create_variant', 16)->default(AttributeCreateVariant::Always->value);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('product_attributes', [
            'display_type' => AttributeDisplayType::values(),
            'create_variant' => AttributeCreateVariant::values(),
        ]);

        Schema::create('product_attribute_values', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_attribute_id')->constrained('product_attributes')->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('html_color', 9)->nullable();
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->boolean('is_custom')->default(false);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->unique(['product_attribute_id', 'name']);
        });

        Schema::create('product_attribute_lines', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('product_attribute_id')->constrained('product_attributes')->restrictOnDelete();
            $table->boolean('is_required')->default(true);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->unique(['product_id', 'product_attribute_id']);
        });

        // Odoo's product.template.attribute.value — what order lines reference.
        Schema::create('product_attribute_line_values', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_attribute_line_id')->constrained('product_attribute_lines')->cascadeOnDelete();
            $table->foreignId('product_attribute_value_id')->constrained('product_attribute_values')->restrictOnDelete();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->decimal('price_extra', 16, 4)->default(0);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();

            $table->unique(['product_attribute_line_id', 'product_attribute_value_id'], 'palv_line_value_unique');
        });

        Schema::create('product_variant_attribute_value', function (Blueprint $table): void {
            $table->foreignId('product_variant_id')->constrained('product_variants')->cascadeOnDelete();
            $table->foreignId('product_attribute_line_value_id')->constrained('product_attribute_line_values')->cascadeOnDelete();

            $table->primary(['product_variant_id', 'product_attribute_line_value_id'], 'pvav_primary');
        });

        Schema::create('product_attribute_exclusions', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('product_attribute_line_value_id')->constrained('product_attribute_line_values')->cascadeOnDelete();
            $table->foreignId('excluded_value_id')->constrained('product_attribute_line_values')->cascadeOnDelete();
            $table->timestamps();

            $table->unique(['product_attribute_line_value_id', 'excluded_value_id'], 'pae_pair_unique');
        });

        // A choice group inside a meal ("Pick a drink").
        Schema::create('combos', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->decimal('base_price', 16, 4)->default(0);
            $table->unsignedSmallInteger('qty_free')->default(1);
            $table->unsignedSmallInteger('qty_max')->default(1);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyRawChecks('combos', [
            'combos_qty_bounds_check' => '(qty_max >= 1 AND qty_free <= qty_max)',
        ]);

        Schema::create('combo_items', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('combo_id')->constrained('combos')->cascadeOnDelete();
            $table->foreignId('product_variant_id')->constrained('product_variants')->restrictOnDelete();
            $table->decimal('extra_price', 16, 4)->default(0);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->unique(['combo_id', 'product_variant_id']);
        });

        Schema::create('combo_product', function (Blueprint $table): void {
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('combo_id')->constrained('combos')->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['product_id', 'combo_id']);
        });

        Schema::create('barcode_nomenclatures', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('upc_ean_conv', 16)->default(UpcEanConversion::Always->value);
            $table->boolean('is_gs1')->default(false);
            $table->timestamps();
        });

        $this->applyChecks('barcode_nomenclatures', ['upc_ean_conv' => UpcEanConversion::values()]);

        Schema::create('barcode_rules', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('barcode_nomenclature_id')->constrained('barcode_nomenclatures')->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('rule_type', 16);
            $table->string('pattern', 64);
            $table->string('encoding', 16)->default(BarcodeEncoding::Any->value);
            $table->string('alias', 64)->nullable();
            $table->integer('sequence')->default(10)->index();
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('barcode_rules', [
            'rule_type' => BarcodeRuleType::values(),
            'encoding' => BarcodeEncoding::values(),
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('barcode_rules');
        Schema::dropIfExists('barcode_nomenclatures');
        Schema::dropIfExists('combo_product');
        Schema::dropIfExists('combo_items');
        Schema::dropIfExists('combos');
        Schema::dropIfExists('product_attribute_exclusions');
        Schema::dropIfExists('product_variant_attribute_value');
        Schema::dropIfExists('product_attribute_line_values');
        Schema::dropIfExists('product_attribute_lines');
        Schema::dropIfExists('product_attribute_values');
        Schema::dropIfExists('product_attributes');
        Schema::dropIfExists('product_optional_products');
        Schema::dropIfExists('product_tag_product');
        Schema::dropIfExists('pos_category_product');
        Schema::dropIfExists('product_packagings');
        Schema::dropIfExists('product_variants');
        Schema::dropIfExists('products');
        Schema::dropIfExists('product_tags');
        Schema::dropIfExists('pos_categories');
        Schema::dropIfExists('product_categories');
        Schema::dropIfExists('uoms');
        Schema::dropIfExists('uom_categories');
    }

    /**
     * Enum columns are `string(N)` + a portable CHECK constraint (spec §0.4).
     * SQLite only accepts CHECK inside CREATE TABLE, so there the backed PHP
     * enum casts are the only guard — acceptable, SQLite is a test target.
     *
     * @param  array<string, list<string>>  $map  column => allowed values
     */
    private function applyChecks(string $table, array $map): void
    {
        $raw = [];

        foreach ($map as $column => $values) {
            $list = implode(', ', array_map(static fn (string $v): string => "'".$v."'", $values));
            $raw["{$table}_{$column}_check"] = $this->quote($column)." IN ({$list})";
        }

        $this->applyRawChecks($table, $raw);
    }

    /**
     * @param  array<string, string>  $constraints  constraint name => boolean expression
     */
    private function applyRawChecks(string $table, array $constraints): void
    {
        if (! in_array(Schema::getConnection()->getDriverName(), ['pgsql', 'mysql', 'mariadb'], true)) {
            return;
        }

        foreach ($constraints as $name => $expression) {
            DB::statement("ALTER TABLE {$this->quote($table)} ADD CONSTRAINT {$name} CHECK ({$expression})");
        }
    }

    /** Quote an identifier: a few enum columns (`trigger`, `state`) are reserved words. */
    private function quote(string $identifier): string
    {
        return Schema::getConnection()->getDriverName() === 'pgsql'
            ? '"'.$identifier.'"'
            : '`'.$identifier.'`';
    }
};
