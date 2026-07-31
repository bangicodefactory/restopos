<?php

declare(strict_types=1);

/**
 * Domain 9 — Self-order, QR menu & kiosk (spec 01-schema §2.I).
 *
 * Tables created here:
 *   self_order_custom_links, pos_config_self_order_custom_link
 *
 * Everything else about self-ordering lives as columns on existing tables:
 * `pos_configs.self_ordering_*`, `restaurant_tables.identifier`,
 * `pos_orders.access_token` / `source` / `self_order_table_id` /
 * `table_stand_number`, `products.self_order_available`,
 * `product_variants.self_order_available`, `pos_categories.self_order_visible`,
 * `pos_presets.available_in_self` / `service_at`, `media_files.collection`,
 * `pos_config_language`, `payment_providers`, `payment_transactions`.
 */

use App\Enums\SelfOrderLinkStyle;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Configurable buttons on the self-order landing page.
        Schema::create('self_order_custom_links', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('url', 512);
            $table->string('style', 16)->default(SelfOrderLinkStyle::Primary->value);
            $table->boolean('open_in_new_tab')->default(false);
            $table->integer('sequence')->default(10)->index();
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('self_order_custom_links', ['style' => SelfOrderLinkStyle::values()]);

        // An empty pivot means "show this link on every config" (Odoo semantics).
        Schema::create('pos_config_self_order_custom_link', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('self_order_custom_link_id')->constrained('self_order_custom_links')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'self_order_custom_link_id'], 'pos_config_self_order_link_primary');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('pos_config_self_order_custom_link');
        Schema::dropIfExists('self_order_custom_links');
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
