<?php

declare(strict_types=1);

/**
 * Domain 3 — Pricing & tax (spec 01-schema §2.C).
 *
 * Tables created here:
 *   currencies, currency_rates, decimal_precisions, cash_roundings,
 *   tax_groups, taxes, tax_children, product_tax, product_variant_tax,
 *   fiscal_positions, fiscal_position_taxes, pricelists, pricelist_items
 *
 * This is the part of the schema kept at full Odoo fidelity: the client-side tax
 * engine and pricelist resolver must reproduce the server's numbers to the cent.
 */

use App\Enums\CashRoundingMethod;
use App\Enums\PricelistAppliedOn;
use App\Enums\PricelistBase;
use App\Enums\PricelistComputePrice;
use App\Enums\SymbolPosition;
use App\Enums\TaxAmountType;
use App\Enums\TaxRoundingStrategy;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('currencies', function (Blueprint $table): void {
            $table->id();
            $table->char('code', 3)->unique();
            $table->string('name', 64);
            $table->string('symbol', 8);
            $table->string('symbol_position', 8)->default(SymbolPosition::After->value);
            $table->unsignedTinyInteger('decimal_places')->default(2);
            $table->decimal('rounding', 12, 6)->default(0.01);
            $table->unsignedSmallInteger('iso_numeric')->nullable();
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('currencies', ['symbol_position' => SymbolPosition::values()]);

        Schema::create('currency_rates', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('currency_id')->constrained()->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->date('rate_date');
            $table->decimal('rate', 24, 12);
            $table->timestamps();

            $table->unique(['currency_id', 'company_id', 'rate_date']);
        });

        Schema::create('decimal_precisions', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 64)->unique();
            $table->unsignedTinyInteger('digits')->default(2);
            $table->timestamps();
        });

        Schema::create('cash_roundings', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->decimal('rounding', 12, 6)->default(0.05);
            $table->string('rounding_method', 16)->default(CashRoundingMethod::HalfUp->value);
            $table->timestamps();
        });

        $this->applyChecks('cash_roundings', ['rounding_method' => CashRoundingMethod::values()]);

        Schema::create('tax_groups', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('receipt_label', 64)->nullable();
            $table->integer('sequence')->default(10)->index();
            $table->timestamps();
        });

        Schema::create('taxes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('tax_group_id')->constrained('tax_groups')->restrictOnDelete();
            $table->string('name', 96);
            $table->string('description', 64)->nullable();
            $table->string('amount_type', 16)->default(TaxAmountType::Percent->value);
            $table->decimal('amount', 9, 4)->default(0);
            $table->boolean('price_include')->default(false);
            $table->boolean('include_base_amount')->default(false);
            $table->boolean('is_base_affected')->default(true);
            $table->boolean('has_negative_factor')->default(false);
            // Evaluation order — load-bearing for compound taxes.
            $table->integer('sequence')->default(10)->index();
            $table->string('rounding_strategy', 16)->default(TaxRoundingStrategy::Inherit->value);
            $table->boolean('is_used')->default(false);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();

            $table->index(['company_id', 'active', 'sequence'], 'taxes_company_active_sequence_index');
        });

        $this->applyChecks('taxes', [
            'amount_type' => TaxAmountType::values(),
            'rounding_strategy' => TaxRoundingStrategy::values(),
        ]);

        // Composition for amount_type='group' and compound chains.
        Schema::create('tax_children', function (Blueprint $table): void {
            $table->foreignId('parent_tax_id')->constrained('taxes')->cascadeOnDelete();
            $table->foreignId('child_tax_id')->constrained('taxes')->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['parent_tax_id', 'child_tax_id']);
        });

        Schema::create('product_tax', function (Blueprint $table): void {
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();
            $table->foreignId('tax_id')->constrained('taxes')->restrictOnDelete();

            $table->primary(['product_id', 'tax_id']);
        });

        // If a variant has >=1 row here it REPLACES the template's taxes.
        Schema::create('product_variant_tax', function (Blueprint $table): void {
            $table->foreignId('product_variant_id')->constrained('product_variants')->cascadeOnDelete();
            $table->foreignId('tax_id')->constrained('taxes')->restrictOnDelete();

            $table->primary(['product_variant_id', 'tax_id']);
        });

        Schema::create('fiscal_positions', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->boolean('auto_apply')->default(false);
            $table->foreignId('country_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('state_id')->nullable()->constrained('country_states')->nullOnDelete();
            $table->string('zip_from', 24)->nullable();
            $table->string('zip_to', 24)->nullable();
            $table->boolean('vat_required')->default(false);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        // tax_dest_id NULL means "remove the source tax" (exemption).
        Schema::create('fiscal_position_taxes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('fiscal_position_id')->constrained('fiscal_positions')->cascadeOnDelete();
            $table->foreignId('tax_src_id')->constrained('taxes')->cascadeOnDelete();
            $table->foreignId('tax_dest_id')->nullable()->constrained('taxes')->cascadeOnDelete();
            $table->timestamps();

            $table->unique(['fiscal_position_id', 'tax_src_id', 'tax_dest_id'], 'fpt_src_dest_unique');
        });

        Schema::create('pricelists', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->string('name', 96);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        // Full rule fidelity: the client computes prices offline from these rows.
        Schema::create('pricelist_items', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pricelist_id')->constrained('pricelists')->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('applied_on', 16)->default(PricelistAppliedOn::Global->value);
            $table->foreignId('product_variant_id')->nullable()->constrained('product_variants')->cascadeOnDelete();
            $table->foreignId('product_id')->nullable()->constrained()->cascadeOnDelete();
            $table->foreignId('pos_category_id')->nullable()->constrained('pos_categories')->cascadeOnDelete();
            $table->decimal('min_quantity', 16, 3)->default(0)->index();
            $table->timestamp('date_start')->nullable()->index();
            $table->timestamp('date_end')->nullable()->index();
            $table->string('compute_price', 16)->default(PricelistComputePrice::Fixed->value);
            $table->decimal('fixed_price', 16, 4)->default(0);
            $table->decimal('percent_price', 9, 4)->default(0);
            $table->string('base', 16)->default(PricelistBase::ListPrice->value);
            $table->foreignId('base_pricelist_id')->nullable()->constrained('pricelists')->restrictOnDelete();
            $table->decimal('price_discount', 9, 4)->default(0);
            $table->decimal('price_surcharge', 16, 4)->default(0);
            $table->decimal('price_round', 12, 6)->default(0);
            $table->decimal('price_min_margin', 16, 4)->default(0);
            $table->decimal('price_max_margin', 16, 4)->default(0);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();

            $table->index(['pricelist_id', 'applied_on', 'product_variant_id'], 'pricelist_items_variant_index');
            $table->index(['pricelist_id', 'applied_on', 'product_id'], 'pricelist_items_product_index');
            $table->index(['pricelist_id', 'date_start', 'date_end'], 'pricelist_items_window_index');
        });

        $this->applyChecks('pricelist_items', [
            'applied_on' => PricelistAppliedOn::values(),
            'compute_price' => PricelistComputePrice::values(),
            'base' => PricelistBase::values(),
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('pricelist_items');
        Schema::dropIfExists('pricelists');
        Schema::dropIfExists('fiscal_position_taxes');
        Schema::dropIfExists('fiscal_positions');
        Schema::dropIfExists('product_variant_tax');
        Schema::dropIfExists('product_tax');
        Schema::dropIfExists('tax_children');
        Schema::dropIfExists('taxes');
        Schema::dropIfExists('tax_groups');
        Schema::dropIfExists('cash_roundings');
        Schema::dropIfExists('decimal_precisions');
        Schema::dropIfExists('currency_rates');
        Schema::dropIfExists('currencies');
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
