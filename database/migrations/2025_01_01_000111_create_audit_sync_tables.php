<?php

declare(strict_types=1);

/**
 * Domain 11 — Audit & sync (spec 01-schema §2.K).
 *
 * Tables created here:
 *   audit_logs, pos_order_edit_logs, sync_requests, sync_conflicts,
 *   notification_logs
 *
 * None of these are ever sent to a client (spec §5.4).
 */

use App\Enums\AuditSeverity;
use App\Enums\NotificationChannel;
use App\Enums\NotificationLogState;
use App\Enums\OrderEditAction;
use App\Enums\SyncConflictType;
use App\Enums\SyncResolution;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Single polymorphic trail replacing Odoo's chatter.
        Schema::create('audit_logs', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_config_id')->nullable()->constrained('pos_configs')->nullOnDelete();
            $table->foreignId('pos_session_id')->nullable()->constrained('pos_sessions')->nullOnDelete();
            $table->string('subject_type', 96)->index();
            $table->unsignedBigInteger('subject_id')->index();
            $table->string('event', 64)->index();
            $table->string('severity', 16)->default(AuditSeverity::Info->value)->index();
            $table->foreignId('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('actor_employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->string('message', 500)->nullable();
            $table->json('changes')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('occurred_at', 3)->index();
            $table->timestamps();

            $table->index(['subject_type', 'subject_id', 'occurred_at'], 'audit_logs_subject_index');
            $table->index(['pos_session_id', 'occurred_at'], 'audit_logs_session_index');
        });

        $this->applyChecks('audit_logs', ['severity' => AuditSeverity::values()]);

        // Written only when pos_configs.order_edit_tracking is on.
        Schema::create('pos_order_edit_logs', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('pos_order_line_id')->nullable()->constrained('pos_order_lines')->nullOnDelete();
            $table->char('pos_order_line_uuid', 36)->nullable()->index();
            $table->string('action', 24)->index();
            $table->string('product_name', 255)->nullable();
            $table->string('old_value', 96)->nullable();
            $table->string('new_value', 96)->nullable();
            $table->decimal('amount_impact', 16, 4)->default(0);
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            // Which till the edit came from (BAN-413). Employees share PINs across the counter far
            // more often than anyone admits, so on a two-till venue the employee alone does not
            // identify who was standing there — the device is what separates them.
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->timestamp('occurred_at', 3)->index();
            $table->timestamps();

            // The manager's fraud report: this order's edits, newest first.
            $table->index(['pos_order_id', 'occurred_at'], 'pos_order_edit_logs_order_index');
        });

        $this->applyChecks('pos_order_edit_logs', ['action' => OrderEditAction::values()]);

        // Request-level idempotency + replay protection for the offline queue.
        Schema::create('sync_requests', function (Blueprint $table): void {
            $table->id();
            $table->char('request_uuid', 36)->unique();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->string('endpoint', 64)->index();
            $table->char('payload_hash', 64);
            $table->json('record_uuids')->nullable();
            $table->unsignedSmallInteger('response_status')->nullable();
            $table->json('response_body')->nullable();
            $table->timestamp('processed_at', 3)->nullable()->index();
            $table->unsignedInteger('duration_ms')->nullable();
            $table->timestamps();
        });

        // Anything the sync layer had to resolve or reject — the ops queue.
        Schema::create('sync_conflicts', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_device_id')->nullable()->constrained('pos_devices')->nullOnDelete();
            $table->string('conflict_type', 32)->index();
            $table->string('model_type', 96);
            $table->char('record_uuid', 36)->index();
            $table->string('resolution', 16)->index();
            $table->json('detail')->nullable();
            $table->timestamp('detected_at', 3)->index();
            $table->foreignId('resolved_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('acknowledged_at')->nullable();
            $table->timestamps();
        });

        $this->applyChecks('sync_conflicts', [
            'conflict_type' => SyncConflictType::values(),
            'resolution' => SyncResolution::values(),
        ]);

        // Delivery record for receipt e-mails / SMS.
        Schema::create('notification_logs', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('notification_template_id')->nullable()->constrained('notification_templates')->nullOnDelete();
            $table->foreignId('pos_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->foreignId('loyalty_card_id')->nullable()->constrained('loyalty_cards')->nullOnDelete();
            $table->string('channel', 8)->index();
            $table->string('recipient', 160)->index();
            $table->string('subject', 255)->nullable();
            $table->string('state', 16)->default(NotificationLogState::Queued->value)->index();
            $table->string('error_message', 255)->nullable();
            $table->timestamp('sent_at', 3)->nullable();
            $table->timestamps();
        });

        $this->applyChecks('notification_logs', [
            'channel' => NotificationChannel::values(),
            'state' => NotificationLogState::values(),
        ]);
    }

    public function down(): void
    {
        Schema::dropIfExists('notification_logs');
        Schema::dropIfExists('sync_conflicts');
        Schema::dropIfExists('sync_requests');
        Schema::dropIfExists('pos_order_edit_logs');
        Schema::dropIfExists('audit_logs');
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
