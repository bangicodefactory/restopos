<?php

declare(strict_types=1);

/**
 * Domain 8 — Kitchen: preparation display & printing (spec 01-schema §2.H).
 *
 * Tables created here:
 *   prep_displays, pos_category_prep_display, pos_config_prep_display,
 *   prep_stages, order_preparation_snapshots, prep_orders, prep_order_lines,
 *   prep_line_stage_logs, preparation_print_jobs
 *
 * `order_preparation_snapshots` is the baseline the delta engine diffs against;
 * `server_version` is an optimistic lock replacing Odoo's `metadata.serverDate`
 * string compare.
 */

use App\Enums\PrepChangeType;
use App\Enums\PrepDisplayLayout;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrepStageType;
use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('prep_displays', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->char('access_token', 32)->unique(); // broadcast channel + screen URL
            $table->string('layout', 16)->default(PrepDisplayLayout::Columns->value);
            $table->boolean('auto_advance_on_all_ready')->default(true);
            $table->boolean('show_all_categories')->default(false);
            $table->unsignedSmallInteger('average_prep_minutes')->default(10);
            $table->unsignedSmallInteger('late_threshold_minutes')->default(15);
            $table->unsignedSmallInteger('done_retention_minutes')->default(60);
            $table->boolean('sound_on_new_order')->default(true);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('prep_displays', ['layout' => PrepDisplayLayout::values()]);

        Schema::create('pos_category_prep_display', function (Blueprint $table): void {
            $table->foreignId('prep_display_id')->constrained('prep_displays')->cascadeOnDelete();
            $table->foreignId('pos_category_id')->constrained('pos_categories')->cascadeOnDelete();

            $table->primary(['prep_display_id', 'pos_category_id'], 'pos_category_prep_display_primary');
        });

        Schema::create('pos_config_prep_display', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('prep_display_id')->constrained('prep_displays')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'prep_display_id'], 'pos_config_prep_display_primary');
        });

        // Columns/lanes of a display: To do → Cooking → Ready → Served.
        Schema::create('prep_stages', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('prep_display_id')->constrained('prep_displays')->cascadeOnDelete();
            $table->string('name', 48);
            $table->string('stage_type', 16)->default(PrepStageType::Todo->value)->index();
            $table->string('color', 24)->nullable();
            $table->unsignedSmallInteger('alert_after_minutes')->nullable();
            $table->integer('sequence')->default(10)->index();
            $table->boolean('is_default')->default(false);
            $table->timestamps();

            $table->unique(['prep_display_id', 'sequence']);
        });

        $this->applyChecks('prep_stages', ['stage_type' => PrepStageType::values()]);

        // "What the kitchen already knows" — one row per order.
        Schema::create('order_preparation_snapshots', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_order_id')->unique()->constrained('pos_orders')->cascadeOnDelete();
            $table->json('snapshot');
            $table->text('general_customer_note')->nullable();
            $table->text('internal_note')->nullable();
            $table->unsignedInteger('server_version')->default(0); // optimistic lock
            $table->timestamp('server_date', 3);
            $table->timestamps();
        });

        // An order as seen by ONE display (2 displays ⇒ 2 rows).
        Schema::create('prep_orders', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('prep_display_id')->constrained('prep_displays')->cascadeOnDelete();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->restrictOnDelete();
            $table->string('tracking_number', 12)->nullable()->index();
            $table->string('table_label', 48)->nullable();
            $table->unsignedSmallInteger('guest_count')->default(0);
            $table->string('preset_label', 32)->nullable();
            $table->string('customer_name', 96)->nullable();
            $table->text('order_note')->nullable();
            $table->string('state', 16)->default(PrepOrderState::Pending->value)->index();
            $table->timestamp('fired_at', 3)->index();
            $table->timestamp('first_started_at', 3)->nullable();
            $table->timestamp('ready_at', 3)->nullable();
            $table->timestamp('served_at', 3)->nullable();
            $table->unsignedInteger('prep_seconds')->nullable();
            $table->boolean('is_recalled')->default(false);
            $table->unsignedInteger('sequence_in_display')->nullable();
            $table->timestamps();

            $table->unique(['prep_display_id', 'pos_order_id'], 'prep_orders_display_order_unique');
            $table->index(['prep_display_id', 'state', 'fired_at'], 'prep_orders_board_index');
        });

        $this->applyChecks('prep_orders', ['state' => PrepOrderState::values()]);

        // One row per (prep_order, order line, fired quantity batch): quantities are deltas.
        Schema::create('prep_order_lines', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('prep_order_id')->constrained('prep_orders')->cascadeOnDelete();
            $table->foreignId('pos_order_line_id')->nullable()->constrained('pos_order_lines')->nullOnDelete();
            $table->char('pos_order_line_uuid', 36)->index(); // survives line deletion
            $table->foreignId('prep_stage_id')->nullable()->constrained('prep_stages')->nullOnDelete();
            $table->foreignId('restaurant_course_id')->nullable()->constrained('restaurant_order_courses')->nullOnDelete();
            $table->unsignedSmallInteger('course_index')->default(1);
            $table->foreignId('product_id')->constrained('products')->restrictOnDelete();
            $table->foreignId('pos_category_id')->nullable()->constrained('pos_categories')->nullOnDelete();
            $table->string('display_name', 255);
            $table->decimal('quantity', 16, 3); // negative = cancellation of sent quantity
            $table->string('change_type', 16)->default(PrepChangeType::New->value)->index();
            $table->string('customer_note', 255)->nullable();
            $table->text('internal_note')->nullable();
            $table->char('combo_parent_uuid', 36)->nullable();
            $table->string('state', 16)->default(PrepLineState::Todo->value)->index();
            $table->timestamp('started_at', 3)->nullable();
            $table->timestamp('ready_at', 3)->nullable();
            $table->timestamp('served_at', 3)->nullable();
            $table->timestamp('fired_at', 3)->index();
            $table->timestamps();

            $table->index(['prep_order_id', 'course_index', 'id'], 'prep_order_lines_render_index');
        });

        $this->applyChecks('prep_order_lines', [
            'change_type' => PrepChangeType::values(),
            'state' => PrepLineState::values(),
        ]);

        // Who moved what, when — KDS audit trail and prep-time analytics.
        Schema::create('prep_line_stage_logs', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('prep_order_line_id')->constrained('prep_order_lines')->cascadeOnDelete();
            $table->foreignId('from_stage_id')->nullable()->constrained('prep_stages')->nullOnDelete();
            $table->foreignId('to_stage_id')->nullable()->constrained('prep_stages')->nullOnDelete();
            $table->string('from_state', 16);
            $table->string('to_state', 16);
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->timestamp('moved_at', 3)->index();
            $table->unsignedInteger('duration_seconds')->nullable();
            $table->timestamps();
        });

        // Durable, idempotent print queue — a retry never double-prints.
        Schema::create('preparation_print_jobs', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_printer_id')->nullable()->constrained('pos_printers')->nullOnDelete();
            $table->foreignId('pos_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->string('job_type', 24)->index();
            $table->json('payload');
            $table->text('rendered_text')->nullable();
            $table->unsignedTinyInteger('copies')->default(1);
            $table->string('state', 16)->default(PrintJobState::Queued->value)->index();
            // Render attempts. Incremented on success as well as failure, so it answers "how many
            // times did we try to turn this payload into text" and nothing else.
            $table->unsignedTinyInteger('attempts')->default(0);
            // Delivery attempts, deliberately a separate counter. A ticket that failed to render
            // twice and then printed first time is not a ticket that was printed three times, and
            // one column cannot cap two different failure modes.
            $table->unsignedTinyInteger('print_attempts')->default(0);
            // Who holds the job, and until when. The lease is what stops two agents on one config
            // printing the same ticket twice: the claim is a conditional write, so the loser of the
            // race sees the row already taken instead of a second copy on the pass.
            $table->string('leased_by', 64)->nullable();
            $table->timestamp('leased_until', 3)->nullable();
            $table->string('last_error', 255)->nullable();
            $table->timestamp('queued_at', 3)->index();
            $table->timestamp('printed_at', 3)->nullable();
            $table->timestamps();

            $table->index(['pos_printer_id', 'state', 'queued_at'], 'print_jobs_poll_index');
            // Reclaiming an expired lease scans by state + expiry, not by printer.
            $table->index(['state', 'leased_until'], 'print_jobs_lease_index');
        });

        $this->applyChecks('preparation_print_jobs', [
            'job_type' => PrintJobType::values(),
            'state' => PrintJobState::values(),
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('preparation_print_jobs');
        Schema::dropIfExists('prep_line_stage_logs');
        Schema::dropIfExists('prep_order_lines');
        Schema::dropIfExists('prep_orders');
        Schema::dropIfExists('order_preparation_snapshots');
        Schema::dropIfExists('prep_stages');
        Schema::dropIfExists('pos_config_prep_display');
        Schema::dropIfExists('pos_category_prep_display');
        Schema::dropIfExists('prep_displays');
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
