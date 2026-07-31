<?php

declare(strict_types=1);

/**
 * Partial & composite indexes (spec 01-schema §6.2 / §7 step 033).
 *
 * Creates no tables. Adds everything Laravel's `foreignId()` does not create
 * implicitly, plus the two partial UNIQUE indexes that turn race-prone
 * application checks into database invariants:
 *
 *   1. one open session per register
 *      pos_sessions UNIQUE (pos_config_id) WHERE state <> 'closed' AND NOT is_rescue
 *   2. one draft order per table
 *      pos_orders UNIQUE (restaurant_table_id) WHERE state = 'draft' AND deleted_at IS NULL
 *
 * Portability:
 *   - PostgreSQL / SQLite: native partial unique index (`CREATE UNIQUE INDEX … WHERE …`).
 *   - MySQL 8: no partial indexes, so a STORED generated column holds the key
 *     only while the row qualifies (NULL otherwise — and MySQL allows many NULLs
 *     in a unique index), then a plain unique index on that column.
 */

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $driver = Schema::getConnection()->getDriverName();

        // --- Delta-scan indexes (§6.3): updated_at first on high-churn tables ---
        Schema::table('products', function (Blueprint $table): void {
            $table->index('updated_at', 'products_updated_at_index');
        });

        Schema::table('product_variants', function (Blueprint $table): void {
            $table->index('updated_at', 'product_variants_updated_at_index');
            $table->index(['company_id', 'active'], 'product_variants_company_active_index');
        });

        Schema::table('pricelist_items', function (Blueprint $table): void {
            $table->index('updated_at', 'pricelist_items_updated_at_index');
        });

        Schema::table('pos_order_lines', function (Blueprint $table): void {
            $table->index(['updated_at', 'company_id'], 'pos_order_lines_delta_index');
            $table->index(['pos_category_id', 'created_at'], 'pos_order_lines_category_date_index');
        });

        Schema::table('pos_payments', function (Blueprint $table): void {
            $table->index(['updated_at', 'company_id'], 'pos_payments_delta_index');
            $table->index('pos_order_id', 'pos_payments_order_index');
        });

        Schema::table('restaurant_order_courses', function (Blueprint $table): void {
            $table->index('updated_at', 'restaurant_order_courses_updated_at_index');
        });

        // --- Reporting / dashboard ---
        Schema::table('customers', function (Blueprint $table): void {
            $table->index(['company_id', 'name'], 'customers_company_name_index');
        });

        Schema::table('prep_order_lines', function (Blueprint $table): void {
            $table->index(['prep_stage_id', 'state'], 'prep_order_lines_stage_state_index');
        });

        Schema::table('sync_requests', function (Blueprint $table): void {
            $table->index(['pos_config_id', 'processed_at'], 'sync_requests_config_processed_index');
        });

        // --- Ordered / partial indexes that need raw SQL ---
        if ($driver === 'pgsql') {
            // Ticket-screen keyset pagination.
            DB::statement('CREATE INDEX pos_orders_ticket_screen_index ON pos_orders (pos_config_id, ordered_at DESC, id DESC)');
            // Top-N customer preload.
            DB::statement('CREATE INDEX customers_top_index ON customers (company_id, order_count DESC)');
            // Refundable-quantity computation.
            DB::statement('CREATE INDEX pos_order_lines_refunded_index ON pos_order_lines (refunded_order_line_id) WHERE refunded_order_line_id IS NOT NULL');
            // One open session per register.
            DB::statement("CREATE UNIQUE INDEX pos_sessions_open_unique ON pos_sessions (pos_config_id) WHERE state <> 'closed' AND is_rescue = false");
            // One draft order per table.
            DB::statement("CREATE UNIQUE INDEX pos_orders_draft_table_unique ON pos_orders (restaurant_table_id) WHERE state = 'draft' AND deleted_at IS NULL AND restaurant_table_id IS NOT NULL");
        } elseif (in_array($driver, ['mysql', 'mariadb'], true)) {
            DB::statement('CREATE INDEX pos_orders_ticket_screen_index ON pos_orders (pos_config_id, ordered_at DESC, id DESC)');
            DB::statement('CREATE INDEX customers_top_index ON customers (company_id, order_count DESC)');
            DB::statement('CREATE INDEX pos_order_lines_refunded_index ON pos_order_lines (refunded_order_line_id)');

            // MySQL has no partial index: emulate it with a STORED generated column
            // that is NULL whenever the row is outside the partial predicate.
            DB::statement(
                'ALTER TABLE pos_sessions ADD COLUMN open_session_key BIGINT UNSIGNED '.
                "GENERATED ALWAYS AS (CASE WHEN state <> 'closed' AND is_rescue = 0 THEN pos_config_id ELSE NULL END) STORED"
            );
            DB::statement('CREATE UNIQUE INDEX pos_sessions_open_unique ON pos_sessions (open_session_key)');

            DB::statement(
                'ALTER TABLE pos_orders ADD COLUMN draft_table_key BIGINT UNSIGNED '.
                "GENERATED ALWAYS AS (CASE WHEN state = 'draft' AND deleted_at IS NULL THEN restaurant_table_id ELSE NULL END) STORED"
            );
            DB::statement('CREATE UNIQUE INDEX pos_orders_draft_table_unique ON pos_orders (draft_table_key)');
        } else {
            // SQLite (tests): supports partial indexes but not DESC-only gains.
            DB::statement('CREATE INDEX pos_orders_ticket_screen_index ON pos_orders (pos_config_id, ordered_at DESC, id DESC)');
            DB::statement('CREATE INDEX customers_top_index ON customers (company_id, order_count DESC)');
            DB::statement('CREATE INDEX pos_order_lines_refunded_index ON pos_order_lines (refunded_order_line_id) WHERE refunded_order_line_id IS NOT NULL');
            DB::statement("CREATE UNIQUE INDEX pos_sessions_open_unique ON pos_sessions (pos_config_id) WHERE state <> 'closed' AND is_rescue = 0");
            DB::statement("CREATE UNIQUE INDEX pos_orders_draft_table_unique ON pos_orders (restaurant_table_id) WHERE state = 'draft' AND deleted_at IS NULL AND restaurant_table_id IS NOT NULL");
        }
    }

    public function down(): void
    {
        $driver = Schema::getConnection()->getDriverName();

        foreach ([
            'pos_orders_draft_table_unique',
            'pos_sessions_open_unique',
            'pos_order_lines_refunded_index',
            'customers_top_index',
            'pos_orders_ticket_screen_index',
        ] as $index) {
            if (in_array($driver, ['mysql', 'mariadb'], true)) {
                $table = str_starts_with($index, 'pos_sessions') ? 'pos_sessions'
                    : (str_starts_with($index, 'pos_orders') ? 'pos_orders'
                    : (str_starts_with($index, 'customers') ? 'customers' : 'pos_order_lines'));
                DB::statement("DROP INDEX {$index} ON {$table}");
            } else {
                DB::statement("DROP INDEX IF EXISTS {$index}");
            }
        }

        if (in_array($driver, ['mysql', 'mariadb'], true)) {
            DB::statement('ALTER TABLE pos_sessions DROP COLUMN open_session_key');
            DB::statement('ALTER TABLE pos_orders DROP COLUMN draft_table_key');
        }

        Schema::table('sync_requests', fn (Blueprint $t) => $t->dropIndex('sync_requests_config_processed_index'));
        Schema::table('prep_order_lines', fn (Blueprint $t) => $t->dropIndex('prep_order_lines_stage_state_index'));
        Schema::table('customers', fn (Blueprint $t) => $t->dropIndex('customers_company_name_index'));
        Schema::table('restaurant_order_courses', fn (Blueprint $t) => $t->dropIndex('restaurant_order_courses_updated_at_index'));
        Schema::table('pos_payments', function (Blueprint $t): void {
            $t->dropIndex('pos_payments_delta_index');
            $t->dropIndex('pos_payments_order_index');
        });
        Schema::table('pos_order_lines', function (Blueprint $t): void {
            $t->dropIndex('pos_order_lines_delta_index');
            $t->dropIndex('pos_order_lines_category_date_index');
        });
        Schema::table('pricelist_items', fn (Blueprint $t) => $t->dropIndex('pricelist_items_updated_at_index'));
        Schema::table('product_variants', function (Blueprint $t): void {
            $t->dropIndex('product_variants_updated_at_index');
            $t->dropIndex('product_variants_company_active_index');
        });
        Schema::table('products', fn (Blueprint $t) => $t->dropIndex('products_updated_at_index'));
    }
};
