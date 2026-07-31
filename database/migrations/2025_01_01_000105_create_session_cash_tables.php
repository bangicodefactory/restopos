<?php

declare(strict_types=1);

/**
 * Domain 5 — Sessions & cash (spec 01-schema §2.E).
 *
 * Tables created here:
 *   pos_sessions, cash_movements, session_cash_counts, session_cash_count_lines,
 *   session_payment_totals, session_sales_summaries, session_tax_summaries,
 *   accounting_exports, accounting_export_session
 *
 * There is no double-entry engine: these summary tables are what an external
 * ledger is fed from (spec §0.8).
 *
 * The partial unique index enforcing "one open session per register" is created
 * in 2025_01_01_000113_add_performance_indexes.
 */

use App\Enums\AccountingExportFormat;
use App\Enums\AccountingExportState;
use App\Enums\CashCountType;
use App\Enums\CashMovementType;
use App\Enums\SessionState;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // A cashier work period on one register.
        Schema::create('pos_sessions', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->restrictOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->string('name', 48)->index();
            $table->string('state', 24)->default(SessionState::OpeningControl->value)->index();
            $table->foreignId('opened_by_user_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->foreignId('opened_by_employee_id')->nullable()->constrained('employees')->restrictOnDelete();
            $table->foreignId('closed_by_user_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->foreignId('closed_by_employee_id')->nullable()->constrained('employees')->restrictOnDelete();
            // The manager who signed off on an over-variance close (REG-016); null otherwise.
            $table->foreignId('over_variance_approved_by_employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->timestamp('opened_at')->nullable()->index();
            $table->timestamp('closed_at')->nullable()->index();
            $table->date('business_date')->index();
            $table->text('opening_notes')->nullable();
            $table->text('closing_notes')->nullable();
            $table->boolean('has_cash_control')->default(false);
            $table->decimal('cash_balance_opening', 16, 4)->default(0);
            $table->decimal('cash_balance_opening_expected', 16, 4)->default(0);
            $table->decimal('cash_balance_closing_counted', 16, 4)->nullable();
            $table->decimal('cash_balance_closing_expected', 16, 4)->default(0);
            $table->decimal('cash_difference', 16, 4)->default(0);
            $table->decimal('cash_in_total', 16, 4)->default(0);
            $table->decimal('cash_out_total', 16, 4)->default(0);
            $table->unsignedInteger('order_count')->default(0);
            $table->decimal('order_amount_total', 16, 4)->default(0);
            $table->decimal('refund_amount_total', 16, 4)->default(0);
            $table->decimal('payments_total', 16, 4)->default(0);
            $table->boolean('is_rescue')->default(false)->index();
            $table->foreignId('rescued_from_session_id')->nullable()->constrained('pos_sessions')->nullOnDelete();
            $table->boolean('closing_forced')->default(false);
            $table->string('closing_force_reason', 255)->nullable();
            $table->timestamp('accounting_exported_at')->nullable()->index();
            $table->timestamps();

            $table->index(['pos_config_id', 'state']);
        });

        $this->applyChecks('pos_sessions', ['state' => SessionState::values()]);

        // Every non-order movement of physical cash.
        Schema::create('cash_movements', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('movement_type', 24)->default(CashMovementType::CashIn->value)->index();
            $table->decimal('amount', 16, 4); // signed: in = +, out = −
            $table->string('reason', 255)->nullable();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->foreignId('user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->timestamp('moved_at', 3)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['pos_session_id', 'movement_type']);
        });

        $this->applyChecks('cash_movements', ['movement_type' => CashMovementType::values()]);

        // A denomination count event (opening / closing / mid-shift).
        Schema::create('session_cash_counts', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();
            $table->string('count_type', 16)->default(CashCountType::Opening->value);
            $table->decimal('total_counted', 16, 4)->default(0);
            $table->foreignId('counted_by_employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->timestamp('counted_at', 3);
            $table->text('notes')->nullable();
            $table->timestamps();

            $table->index(['pos_session_id', 'count_type']);
        });

        $this->applyChecks('session_cash_counts', ['count_type' => CashCountType::values()]);

        Schema::create('session_cash_count_lines', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('session_cash_count_id')->constrained('session_cash_counts')->cascadeOnDelete();
            $table->foreignId('pos_bill_id')->nullable()->constrained('pos_bills')->nullOnDelete();
            $table->decimal('denomination_value', 16, 4);
            $table->unsignedInteger('quantity')->default(0);
            $table->decimal('subtotal', 16, 4);
            $table->timestamps();
        });

        // Per-session × payment-method closing figures.
        Schema::create('session_payment_totals', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();
            $table->foreignId('payment_method_id')->constrained('payment_methods')->restrictOnDelete();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->decimal('expected_amount', 16, 4)->default(0);
            $table->decimal('counted_amount', 16, 4)->nullable();
            $table->decimal('difference_amount', 16, 4)->default(0);
            $table->unsignedInteger('payment_count')->default(0);
            $table->decimal('refund_amount', 16, 4)->default(0);
            $table->decimal('change_amount', 16, 4)->default(0);
            $table->string('ledger_code', 32)->nullable();
            $table->timestamps();

            $table->unique(['pos_session_id', 'payment_method_id'], 'session_payment_totals_unique');
        });

        // Frozen revenue breakdown of a closed session.
        Schema::create('session_sales_summaries', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();
            $table->foreignId('pos_category_id')->nullable()->constrained('pos_categories')->nullOnDelete();
            $table->foreignId('product_id')->nullable()->constrained('products')->nullOnDelete();
            $table->string('tax_signature', 64)->index();
            $table->boolean('is_refund')->default(false)->index();
            $table->decimal('quantity', 16, 3)->default(0);
            $table->decimal('base_amount', 16, 4)->default(0);
            $table->decimal('discount_amount', 16, 4)->default(0);
            $table->decimal('tax_amount', 16, 4)->default(0);
            $table->decimal('total_amount', 16, 4)->default(0);
            $table->decimal('cost_amount', 16, 4)->default(0);
            $table->string('ledger_code', 32)->nullable();
            $table->timestamps();

            $table->index(['pos_session_id', 'is_refund']);
        });

        Schema::create('session_tax_summaries', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();
            $table->foreignId('tax_id')->constrained('taxes')->restrictOnDelete();
            $table->foreignId('tax_group_id')->constrained('tax_groups')->restrictOnDelete();
            $table->boolean('is_refund')->default(false);
            $table->decimal('base_amount', 16, 4)->default(0);
            $table->decimal('tax_amount', 16, 4)->default(0);
            $table->decimal('tax_rate', 9, 4);
            $table->timestamps();

            $table->unique(['pos_session_id', 'tax_id', 'is_refund'], 'session_tax_summaries_unique');
        });

        // A batch turning N closed sessions into a file / API push.
        Schema::create('accounting_exports', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->date('period_start');
            $table->date('period_end');
            $table->string('format', 8)->default(AccountingExportFormat::Csv->value);
            $table->string('state', 16)->default(AccountingExportState::Draft->value)->index();
            $table->unsignedInteger('session_count')->default(0);
            $table->decimal('total_sales', 16, 4)->default(0);
            $table->decimal('total_tax', 16, 4)->default(0);
            $table->decimal('total_payments', 16, 4)->default(0);
            $table->decimal('imbalance_amount', 16, 4)->default(0);
            $table->foreignId('media_file_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->foreignId('generated_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->text('error_message')->nullable();
            $table->timestamps();
        });

        $this->applyChecks('accounting_exports', [
            'format' => AccountingExportFormat::values(),
            'state' => AccountingExportState::values(),
        ]);

        Schema::create('accounting_export_session', function (Blueprint $table): void {
            $table->foreignId('accounting_export_id')->constrained('accounting_exports')->cascadeOnDelete();
            $table->foreignId('pos_session_id')->constrained('pos_sessions')->cascadeOnDelete();

            $table->primary(['accounting_export_id', 'pos_session_id'], 'accounting_export_session_primary');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('accounting_export_session');
        Schema::dropIfExists('accounting_exports');
        Schema::dropIfExists('session_tax_summaries');
        Schema::dropIfExists('session_sales_summaries');
        Schema::dropIfExists('session_payment_totals');
        Schema::dropIfExists('session_cash_count_lines');
        Schema::dropIfExists('session_cash_counts');
        Schema::dropIfExists('cash_movements');
        Schema::dropIfExists('pos_sessions');
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
