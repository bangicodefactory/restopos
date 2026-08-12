<?php

declare(strict_types=1);

/**
 * Domain 6 — Orders (spec 01-schema §2.F).
 *
 * Tables created here:
 *   pos_orders, pos_order_lines, pos_order_line_attribute_value,
 *   pos_order_line_custom_attribute_values, payment_transactions, pos_payments,
 *   pos_invoices, pos_invoice_lines, customer_account_moves
 *
 * uuid-first: the client mints every uuid, the server never re-issues one, and
 * `POST /api/pos/sync` is a pure upsert keyed on it.
 *
 * Deferred (2025_01_01_000112_add_deferred_foreign_keys):
 *   pos_orders.pos_invoice_id (cycle with pos_invoices.pos_order_id),
 *   pos_order_lines.loyalty_reward_id / loyalty_card_id (loyalty domain runs later).
 */

use App\Enums\CustomerAccountMoveType;
use App\Enums\InvoiceLineType;
use App\Enums\InvoiceState;
use App\Enums\InvoiceType;
use App\Enums\OrderPrepState;
use App\Enums\OrderSource;
use App\Enums\OrderState;
use App\Enums\PaymentStatus;
use App\Enums\PaymentTransactionState;
use App\Enums\PriceType;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pos_orders', function (Blueprint $table): void {
            // Identity & routing
            $table->id();
            $table->char('uuid', 36)->unique(); // idempotency key for sync
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->restrictOnDelete();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->restrictOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->string('name', 64)->nullable()->index();
            $table->string('receipt_number', 48)->nullable()->index();
            $table->string('tracking_number', 12)->nullable()->index();
            $table->integer('sequence_number')->nullable();
            $table->char('access_token', 36)->index();
            $table->char('ticket_code', 5)->nullable()->index();
            $table->string('source', 16)->default(OrderSource::Pos->value)->index();

            // Business
            $table->string('state', 16)->default(OrderState::Draft->value)->index();
            $table->timestamp('ordered_at', 3)->index();
            $table->timestamp('paid_at', 3)->nullable()->index();
            $table->timestamp('closed_at', 3)->nullable();
            $table->timestamp('cancelled_at')->nullable();
            $table->string('cancel_reason', 255)->nullable();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->foreignId('user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('pricelist_id')->nullable()->constrained('pricelists')->restrictOnDelete();
            $table->foreignId('fiscal_position_id')->nullable()->constrained('fiscal_positions')->restrictOnDelete();
            $table->foreignId('pos_preset_id')->nullable()->constrained('pos_presets')->restrictOnDelete();
            $table->timestamp('preset_time')->nullable()->index();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->decimal('currency_rate', 24, 12)->default(1);
            $table->string('floating_order_name', 96)->nullable();

            // Amounts — always recomputed server-side, the client is never trusted.
            $table->decimal('amount_untaxed', 16, 4)->default(0);
            $table->decimal('amount_tax', 16, 4)->default(0);
            $table->decimal('amount_total', 16, 4)->default(0)->index();
            $table->decimal('amount_rounding', 16, 4)->default(0);
            $table->decimal('amount_paid', 16, 4)->default(0);
            $table->decimal('amount_change', 16, 4)->default(0);
            $table->decimal('amount_due', 16, 4)->default(0);
            // Money the sale was short at settlement and will never collect (BAN-514). The register
            // takes what its own catalogue displayed; the server prices from the live catalogue.
            // When those disagree on an order that is already paid, the difference is not a debt —
            // the customer has gone — so it is written off here, named, and left attributable to
            // the order's device and employee, rather than sitting in `amount_due` forever and
            // reaching the accounting export as an unexplained imbalance.
            $table->decimal('amount_write_off', 16, 4)->default(0);
            $table->decimal('amount_discount', 16, 4)->default(0);
            $table->decimal('total_cost', 16, 4)->default(0);
            $table->decimal('margin', 16, 4)->default(0);
            $table->decimal('margin_percent', 9, 4)->default(0);
            $table->json('tax_details')->nullable();

            // Restaurant
            $table->foreignId('restaurant_table_id')->nullable()->constrained('restaurant_tables')->nullOnDelete();
            $table->unsignedSmallInteger('guest_count')->default(0);
            $table->boolean('is_tipped')->default(false);
            $table->decimal('tip_amount', 16, 4)->default(0);
            $table->foreignId('split_from_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->char('split_letter', 1)->nullable();
            $table->foreignId('merged_into_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();

            // Refund / invoice
            $table->boolean('is_refund')->default(false)->index();
            $table->foreignId('refunded_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->unsignedSmallInteger('refund_count')->default(0);
            $table->boolean('has_refundable_lines')->default(true);
            $table->boolean('to_invoice')->default(false)->index();
            $table->unsignedBigInteger('pos_invoice_id')->nullable()->index(); // FK deferred

            // Kitchen & notes
            $table->text('general_customer_note')->nullable();
            $table->text('internal_note')->nullable();
            $table->string('prep_state', 24)->default(OrderPrepState::None->value)->index();
            $table->unsignedSmallInteger('unsent_change_count')->default(0);
            $table->timestamp('last_prep_sent_at', 3)->nullable();

            // Self-order
            $table->foreignId('self_order_table_id')->nullable()->constrained('restaurant_tables')->nullOnDelete();
            $table->string('table_stand_number', 16)->nullable();
            $table->string('customer_email', 160)->nullable();
            $table->string('customer_phone', 40)->nullable();
            $table->boolean('use_self_online_payment')->default(false);

            // Audit / print
            $table->unsignedSmallInteger('print_count')->default(0);
            $table->boolean('is_edited')->default(false)->index();
            $table->boolean('has_deleted_line')->default(false);
            $table->timestamp('client_created_at', 3)->nullable();
            $table->timestamp('synced_at', 3)->nullable()->index();
            $table->json('ui_state')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['pos_config_id', 'state', 'deleted_at'], 'pos_orders_config_state_index');
            $table->index(['pos_session_id', 'state'], 'pos_orders_session_state_index');
            $table->index(['restaurant_table_id', 'state'], 'pos_orders_table_state_index');
            $table->index(['company_id', 'updated_at'], 'pos_orders_delta_index');

            // The number the counter calls out has to be unique *within the service*, or two
            // customers answer to it (SLF-043). Picking the lowest free number is not enough on its
            // own: two kiosks submitting at once both read the same free number, and kiosks are
            // exactly the concurrent case. This is what actually makes it true; the picker retries
            // when it loses.
            $table->unique(['pos_session_id', 'tracking_number'], 'pos_orders_session_tracking_unique');
        });

        $this->applyChecks('pos_orders', [
            'state' => OrderState::values(),
            'source' => OrderSource::values(),
            'prep_state' => OrderPrepState::values(),
        ]);

        Schema::create('pos_order_lines', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('line_number')->nullable();
            $table->foreignId('product_variant_id')->constrained('product_variants')->restrictOnDelete();
            $table->foreignId('product_id')->constrained('products')->restrictOnDelete();
            // Frozen primary category: kitchen routing must survive a recategorisation.
            $table->foreignId('pos_category_id')->nullable()->constrained('pos_categories')->nullOnDelete();
            $table->string('full_product_name', 255);
            $table->foreignId('uom_id')->constrained('uoms')->restrictOnDelete();
            $table->decimal('quantity', 16, 3)->default(1); // negative for refunds
            $table->decimal('price_unit', 16, 4)->default(0);
            $table->decimal('price_extra', 16, 4)->default(0);
            $table->string('price_type', 16)->default(PriceType::Original->value);
            $table->decimal('discount_percent', 9, 4)->default(0);
            $table->decimal('discount_amount', 16, 4)->default(0);
            $table->string('discount_notice', 96)->nullable();
            $table->decimal('price_subtotal', 16, 4)->default(0);
            $table->decimal('price_subtotal_incl', 16, 4)->default(0);
            $table->json('tax_details')->nullable();
            $table->string('tax_signature', 64)->index();
            $table->decimal('unit_cost', 16, 4)->default(0);
            $table->decimal('total_cost', 16, 4)->default(0);
            $table->decimal('margin', 16, 4)->default(0);
            $table->string('customer_note', 255)->nullable();
            $table->json('internal_note')->nullable(); // [{text, color_index}]
            $table->foreignId('combo_parent_line_id')->nullable()->constrained('pos_order_lines')->cascadeOnDelete();
            $table->foreignId('combo_id')->nullable()->constrained('combos')->nullOnDelete();
            $table->foreignId('combo_item_id')->nullable()->constrained('combo_items')->nullOnDelete();
            $table->foreignId('restaurant_course_id')->nullable()->constrained('restaurant_order_courses')->nullOnDelete();
            $table->foreignId('refunded_order_line_id')->nullable()->constrained('pos_order_lines')->nullOnDelete();
            $table->decimal('refunded_quantity', 16, 3)->default(0);
            $table->boolean('is_reward_line')->default(false)->index();
            $table->unsignedBigInteger('loyalty_reward_id')->nullable()->index(); // FK deferred
            $table->unsignedBigInteger('loyalty_card_id')->nullable()->index();   // FK deferred
            $table->string('reward_identifier_code', 48)->nullable()->index();
            $table->decimal('points_cost', 16, 3)->default(0);
            $table->boolean('is_edited')->default(false);
            $table->boolean('skip_preparation')->default(false);
            $table->json('ui_state')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['pos_order_id', 'line_number']);
            $table->index(['product_variant_id', 'created_at'], 'pos_order_lines_variant_date_index');
        });

        $this->applyChecks('pos_order_lines', ['price_type' => PriceType::values()]);

        // `no_variant` attribute values riding on the line.
        Schema::create('pos_order_line_attribute_value', function (Blueprint $table): void {
            $table->foreignId('pos_order_line_id')->constrained('pos_order_lines')->cascadeOnDelete();
            $table->foreignId('product_attribute_line_value_id')->constrained('product_attribute_line_values')->restrictOnDelete();
            $table->decimal('price_extra', 16, 4)->default(0);

            $table->primary(['pos_order_line_id', 'product_attribute_line_value_id'], 'pos_order_line_attribute_value_primary');
        });

        Schema::create('pos_order_line_custom_attribute_values', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_order_line_id')->constrained('pos_order_lines')->cascadeOnDelete();
            $table->foreignId('product_attribute_line_value_id')->constrained('product_attribute_line_values')->restrictOnDelete();
            $table->string('custom_value', 255);
            $table->timestamps();
        });

        // Online payment attempt (phone, kiosk QR, cashier-presented QR).
        Schema::create('payment_transactions', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('payment_provider_id')->constrained('payment_providers')->restrictOnDelete();
            $table->foreignId('payment_method_id')->constrained('payment_methods')->restrictOnDelete();
            $table->string('reference', 96)->unique();
            $table->string('provider_reference', 128)->nullable()->index();
            $table->decimal('amount', 16, 4);
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->string('state', 16)->default(PaymentTransactionState::Draft->value)->index();
            $table->text('state_message')->nullable();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->json('payload')->nullable();
            $table->timestamp('initiated_at', 3)->nullable();
            $table->timestamp('completed_at', 3)->nullable();
            $table->timestamps();
        });

        $this->applyChecks('payment_transactions', ['state' => PaymentTransactionState::values()]);

        Schema::create('pos_payments', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->restrictOnDelete();
            $table->foreignId('payment_method_id')->constrained('payment_methods')->restrictOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->decimal('amount', 16, 4); // negative = change or refund
            $table->decimal('amount_company_currency', 16, 4);
            $table->boolean('is_change')->default(false)->index();
            $table->boolean('is_refund')->default(false);
            $table->string('label', 96)->nullable();
            $table->timestamp('paid_at', 3)->index();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->string('payment_status', 16)->default(PaymentStatus::Done->value)->index();

            // Terminal metadata — never a full PAN.
            $table->string('card_type', 32)->nullable();
            $table->string('card_brand', 32)->nullable();
            $table->char('card_last4', 4)->nullable();
            $table->string('cardholder_name', 96)->nullable();
            $table->string('auth_code', 32)->nullable();
            $table->string('transaction_reference', 96)->nullable()->index();
            $table->string('issuer_bank', 64)->nullable();
            $table->string('entry_mode', 24)->nullable();
            $table->json('terminal_payload')->nullable();
            $table->text('terminal_ticket')->nullable();
            $table->foreignId('payment_transaction_id')->nullable()->constrained('payment_transactions')->nullOnDelete();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['pos_session_id', 'payment_method_id'], 'pos_payments_closing_index');
        });

        $this->applyChecks('pos_payments', ['payment_status' => PaymentStatus::values()]);

        // A lean, immutable customer invoice document — not a ledger entry.
        Schema::create('pos_invoices', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_order_id')->unique()->constrained('pos_orders')->restrictOnDelete();
            $table->string('number', 48)->unique();
            $table->string('invoice_type', 16)->default(InvoiceType::Invoice->value);
            $table->foreignId('reversed_invoice_id')->nullable()->constrained('pos_invoices')->nullOnDelete();
            $table->foreignId('customer_id')->constrained('customers')->restrictOnDelete();
            $table->json('customer_snapshot');
            $table->timestamp('issued_at')->index();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->decimal('amount_untaxed', 16, 4)->default(0);
            $table->decimal('amount_tax', 16, 4)->default(0);
            $table->decimal('amount_total', 16, 4)->default(0);
            $table->json('tax_details');
            $table->foreignId('pdf_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->timestamp('sent_at')->nullable();
            $table->string('state', 16)->default(InvoiceState::Issued->value)->index();
            $table->timestamps();
        });

        $this->applyChecks('pos_invoices', [
            'invoice_type' => InvoiceType::values(),
            'state' => InvoiceState::values(),
        ]);

        Schema::create('pos_invoice_lines', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_invoice_id')->constrained('pos_invoices')->cascadeOnDelete();
            $table->foreignId('pos_order_line_id')->nullable()->constrained('pos_order_lines')->nullOnDelete();
            $table->string('line_type', 16)->default(InvoiceLineType::Product->value);
            $table->string('description', 255);
            $table->decimal('quantity', 16, 3)->default(1);
            $table->decimal('price_unit', 16, 4)->default(0);
            $table->decimal('discount_percent', 9, 4)->default(0);
            $table->decimal('price_subtotal', 16, 4)->default(0);
            $table->decimal('price_subtotal_incl', 16, 4)->default(0);
            $table->json('tax_details')->nullable();
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->timestamps();
        });

        $this->applyChecks('pos_invoice_lines', ['line_type' => InvoiceLineType::values()]);

        // Immutable ledger of a customer's running tab (REG-208). Modelled on
        // `loyalty_card_histories`: `balance_after` is stored rather than derived so a statement
        // prints without replaying the table, and `customers.account_balance` caches the head.
        //
        // Lives in the order domain rather than identity because it points at `pos_payments`, and
        // identity runs first. The FK direction is what places it, not the subject matter.
        Schema::create('customer_account_moves', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('customer_id')->constrained('customers')->restrictOnDelete();
            $table->string('move_type', 16)->default(CustomerAccountMoveType::Charge->value)->index();

            // Signed, positive = the customer owes more. `balance` is the plain sum of this column.
            $table->decimal('amount', 16, 4);
            $table->decimal('balance_after', 16, 4);

            $table->foreignId('pos_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();

            // One move per payment, enforced in the database rather than by a service that
            // remembers to check: `POST /api/pos/sync` is a pure upsert and the register retries,
            // so the same pay-later payment arrives more than once as a matter of course. NULL for
            // settlements, and repeated NULLs are permitted by every engine we target.
            $table->foreignId('pos_payment_id')->nullable()->unique()->constrained('pos_payments')->nullOnDelete();

            // How a settlement was taken. Null on a charge — the order's own payments say that.
            $table->foreignId('payment_method_id')->nullable()->constrained('payment_methods')->nullOnDelete();
            $table->foreignId('pos_session_id')->nullable()->constrained('pos_sessions')->nullOnDelete();
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->foreignId('user_id')->nullable()->constrained('users')->nullOnDelete();

            $table->string('description', 160)->nullable();
            $table->timestamp('occurred_at', 3)->index();
            $table->timestamps();

            $table->index(['customer_id', 'occurred_at'], 'customer_account_moves_statement_index');
        });

        $this->applyChecks('customer_account_moves', ['move_type' => CustomerAccountMoveType::values()]);
    }

    public function down(): void
    {
        Schema::dropIfExists('customer_account_moves');
        Schema::dropIfExists('pos_invoice_lines');
        Schema::dropIfExists('pos_invoices');
        Schema::dropIfExists('pos_payments');
        Schema::dropIfExists('payment_transactions');
        Schema::dropIfExists('pos_order_line_custom_attribute_values');
        Schema::dropIfExists('pos_order_line_attribute_value');
        Schema::dropIfExists('pos_order_lines');
        Schema::dropIfExists('pos_orders');
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
