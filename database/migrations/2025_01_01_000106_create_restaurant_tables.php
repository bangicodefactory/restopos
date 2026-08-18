<?php

declare(strict_types=1);

/**
 * Domain 7 — Restaurant (spec 01-schema §2.G).
 *
 * Tables created here:
 *   restaurant_floors, restaurant_tables, pos_config_floor,
 *   restaurant_order_courses, pos_order_merges
 *
 * Runs before the order domain because `pos_orders.restaurant_table_id` and
 * `pos_order_lines.restaurant_course_id` point here. The reverse links
 * (`restaurant_order_courses.pos_order_id`, `pos_order_merges.*_order_id`) are
 * genuine cycles and get their FK in
 * 2025_01_01_000112_add_deferred_foreign_keys.
 */

use App\Enums\MergeType;
use App\Enums\TableShape;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('restaurant_floors', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('background_color', 24)->nullable();
            $table->foreignId('background_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->integer('sequence')->default(1)->index();
            $table->unsignedSmallInteger('table_count')->default(0);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();
        });

        Schema::create('restaurant_tables', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('restaurant_floor_id')->constrained('restaurant_floors')->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('table_number')->default(0)->index();
            $table->string('name', 32)->nullable();
            $table->char('identifier', 8)->unique(); // QR capability token
            $table->string('shape', 8)->default(TableShape::Square->value);
            $table->decimal('position_x', 10, 2)->default(10);
            $table->decimal('position_y', 10, 2)->default(10);
            $table->decimal('width', 10, 2)->default(50);
            $table->decimal('height', 10, 2)->default(50);
            $table->unsignedSmallInteger('seats')->default(2);
            $table->string('color', 24)->nullable();
            // Physical link/merge: the child snaps to its parent and orders merge.
            // RST-059 — a table held for a booking (BAN-523). A timestamp rather than a flag,
            // because "held since 19:40" is what a waiter needs to decide whether the party is late,
            // and a boolean throws that away. Null means free.
            $table->timestamp('booked_at')->nullable();
            $table->string('booked_note', 64)->nullable();
            $table->foreignId('parent_id')->nullable()->constrained('restaurant_tables')->nullOnDelete();
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['restaurant_floor_id', 'active']);
        });

        $this->applyChecks('restaurant_tables', ['shape' => TableShape::values()]);

        Schema::create('pos_config_floor', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('restaurant_floor_id')->constrained('restaurant_floors')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'restaurant_floor_id'], 'pos_config_floor_primary');
        });

        // Courses ("Starters" / "Course 2") — client-created, fired to the kitchen.
        Schema::create('restaurant_order_courses', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->unsignedBigInteger('pos_order_id')->index(); // FK deferred (cycle with pos_order_lines)
            $table->unsignedSmallInteger('course_index')->default(1)->index();
            $table->string('name', 48)->nullable();
            $table->boolean('fired')->default(false)->index();
            $table->timestamp('fired_at', 3)->nullable();
            $table->unsignedSmallInteger('line_count')->default(0);
            $table->timestamps();
            $table->softDeletes();

            $table->index(['pos_order_id', 'course_index']);
        });

        // Audit + restore payload for table linking, transfer, merge and split.
        Schema::create('pos_order_merges', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->unsignedBigInteger('source_order_id')->index(); // FK deferred
            $table->unsignedBigInteger('target_order_id')->index(); // FK deferred
            $table->foreignId('source_table_id')->nullable()->constrained('restaurant_tables')->nullOnDelete();
            $table->string('merge_type', 24)->default(MergeType::OrderMerge->value);
            $table->json('restore_payload');
            $table->json('prep_history_payload')->nullable();
            $table->foreignId('performed_by_employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->timestamp('performed_at', 3);
            $table->timestamp('reverted_at')->nullable();
            $table->timestamps();
        });

        $this->applyChecks('pos_order_merges', ['merge_type' => MergeType::values()]);
    }

    public function down(): void
    {
        Schema::dropIfExists('pos_order_merges');
        Schema::dropIfExists('restaurant_order_courses');
        Schema::dropIfExists('pos_config_floor');
        Schema::dropIfExists('restaurant_tables');
        Schema::dropIfExists('restaurant_floors');
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
