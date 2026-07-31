<?php

declare(strict_types=1);

/**
 * Deferred foreign keys (spec 01-schema §7, step 032).
 *
 * Creates no tables. Adds the FK constraints that could not be declared inline
 * because the two tables reference each other (or belong to domains that must
 * be created in the opposite order):
 *
 *   countries.currency_id                    → currencies
 *   companies.currency_id                    → currencies
 *   companies.logo_media_id                  → media_files
 *   companies.barcode_nomenclature_id        → barcode_nomenclatures
 *   companies.default_customer_id            → customers
 *   users.company_id                         → companies
 *   users.avatar_media_id                    → media_files
 *   customers.pricelist_id                   → pricelists
 *   customers.fiscal_position_id             → fiscal_positions
 *   restaurant_order_courses.pos_order_id    → pos_orders
 *   pos_order_merges.source_order_id         → pos_orders
 *   pos_order_merges.target_order_id         → pos_orders
 *   pos_orders.pos_invoice_id                → pos_invoices
 *   pos_order_lines.loyalty_reward_id        → loyalty_rewards
 *   pos_order_lines.loyalty_card_id          → loyalty_cards
 *
 * SQLite cannot add a foreign key to an existing table (constraints are part of
 * the CREATE TABLE statement); the whole migration is skipped there, which is
 * why every column above is also indexed on its own.
 */

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if ($this->unsupported()) {
            return;
        }

        Schema::table('countries', function (Blueprint $table): void {
            $table->foreign('currency_id')->references('id')->on('currencies')->nullOnDelete();
        });

        Schema::table('companies', function (Blueprint $table): void {
            $table->foreign('currency_id')->references('id')->on('currencies')->restrictOnDelete();
            $table->foreign('logo_media_id')->references('id')->on('media_files')->nullOnDelete();
            $table->foreign('barcode_nomenclature_id')->references('id')->on('barcode_nomenclatures')->nullOnDelete();
            $table->foreign('default_customer_id')->references('id')->on('customers')->nullOnDelete();
        });

        Schema::table('users', function (Blueprint $table): void {
            $table->foreign('company_id')->references('id')->on('companies')->restrictOnDelete();
            $table->foreign('avatar_media_id')->references('id')->on('media_files')->nullOnDelete();
        });

        Schema::table('customers', function (Blueprint $table): void {
            $table->foreign('pricelist_id')->references('id')->on('pricelists')->nullOnDelete();
            $table->foreign('fiscal_position_id')->references('id')->on('fiscal_positions')->nullOnDelete();
        });

        Schema::table('restaurant_order_courses', function (Blueprint $table): void {
            $table->foreign('pos_order_id')->references('id')->on('pos_orders')->cascadeOnDelete();
        });

        Schema::table('pos_order_merges', function (Blueprint $table): void {
            $table->foreign('source_order_id')->references('id')->on('pos_orders')->cascadeOnDelete();
            $table->foreign('target_order_id')->references('id')->on('pos_orders')->cascadeOnDelete();
        });

        Schema::table('pos_orders', function (Blueprint $table): void {
            $table->foreign('pos_invoice_id')->references('id')->on('pos_invoices')->nullOnDelete();
        });

        Schema::table('pos_order_lines', function (Blueprint $table): void {
            $table->foreign('loyalty_reward_id')->references('id')->on('loyalty_rewards')->nullOnDelete();
            $table->foreign('loyalty_card_id')->references('id')->on('loyalty_cards')->nullOnDelete();
        });
    }

    public function down(): void
    {
        if ($this->unsupported()) {
            return;
        }

        Schema::table('pos_order_lines', function (Blueprint $table): void {
            $table->dropForeign(['loyalty_reward_id']);
            $table->dropForeign(['loyalty_card_id']);
        });

        Schema::table('pos_orders', function (Blueprint $table): void {
            $table->dropForeign(['pos_invoice_id']);
        });

        Schema::table('pos_order_merges', function (Blueprint $table): void {
            $table->dropForeign(['source_order_id']);
            $table->dropForeign(['target_order_id']);
        });

        Schema::table('restaurant_order_courses', function (Blueprint $table): void {
            $table->dropForeign(['pos_order_id']);
        });

        Schema::table('customers', function (Blueprint $table): void {
            $table->dropForeign(['pricelist_id']);
            $table->dropForeign(['fiscal_position_id']);
        });

        Schema::table('users', function (Blueprint $table): void {
            $table->dropForeign(['company_id']);
            $table->dropForeign(['avatar_media_id']);
        });

        Schema::table('companies', function (Blueprint $table): void {
            $table->dropForeign(['currency_id']);
            $table->dropForeign(['logo_media_id']);
            $table->dropForeign(['barcode_nomenclature_id']);
            $table->dropForeign(['default_customer_id']);
        });

        Schema::table('countries', function (Blueprint $table): void {
            $table->dropForeign(['currency_id']);
        });
    }

    private function unsupported(): bool
    {
        return ! in_array(Schema::getConnection()->getDriverName(), ['pgsql', 'mysql', 'mariadb'], true);
    }
};
