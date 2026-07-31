<?php

declare(strict_types=1);

/**
 * Domain 1 — Identity, access & devices (spec 01-schema §2.A).
 *
 * Tables created here:
 *   countries, country_states, languages, companies, media_files,
 *   roles, permissions, permission_role, role_user, employees, customers
 *
 * Also extends the framework `users` table (created by the default Laravel
 * migration) with the back-office columns the spec requires.
 *
 * Deferred (see 2025_01_01_000112_add_deferred_foreign_keys):
 *   companies.currency_id, companies.default_customer_id,
 *   companies.barcode_nomenclature_id, companies.logo_media_id,
 *   users.company_id, users.avatar_media_id,
 *   customers.pricelist_id, customers.fiscal_position_id.
 * `pos_devices` lives with the config domain because it belongs to a pos_config.
 */

use App\Enums\AddressType;
use App\Enums\EmployeeRole;
use App\Enums\MediaCollection;
use App\Enums\ReceiptTicketUrlDisplayMode;
use App\Enums\TaxRoundingMethod;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('countries', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 96);
            $table->char('code', 2)->unique();
            $table->unsignedSmallInteger('phone_code')->nullable();
            $table->string('vat_label', 32)->nullable();
            $table->unsignedBigInteger('currency_id')->nullable()->index(); // FK deferred (currencies live in the pricing domain)
            $table->boolean('requires_state')->default(false);
            $table->timestamps();
        });

        Schema::create('country_states', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('country_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('code', 8);
            $table->timestamps();

            $table->unique(['country_id', 'code']);
        });

        Schema::create('languages', function (Blueprint $table): void {
            $table->id();
            $table->string('code', 8)->unique();
            $table->string('iso_code', 5);
            $table->string('name', 64);
            $table->string('flag_url', 255)->nullable();
            $table->boolean('is_rtl')->default(false);
            $table->boolean('active')->default(true)->index();
            $table->integer('sequence')->default(10);
            $table->timestamps();
        });

        Schema::create('companies', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 160);
            $table->string('legal_name', 160)->nullable();
            $table->unsignedBigInteger('currency_id')->index();          // FK deferred
            $table->foreignId('country_id')->nullable()->constrained()->restrictOnDelete();
            $table->foreignId('state_id')->nullable()->constrained('country_states')->nullOnDelete();
            $table->string('vat', 32)->nullable()->index();
            $table->string('company_registry', 64)->nullable();
            $table->string('street', 128)->nullable();
            $table->string('street2', 128)->nullable();
            $table->string('city', 96)->nullable();
            $table->string('zip', 24)->nullable();
            $table->string('phone', 64)->nullable();
            $table->string('email', 160)->nullable();
            $table->string('website', 160)->nullable();
            $table->unsignedBigInteger('logo_media_id')->nullable()->index();       // FK deferred
            $table->string('timezone', 64)->default('UTC');
            $table->string('tax_calculation_rounding_method', 24)->default(TaxRoundingMethod::RoundPerLine->value);
            $table->boolean('price_include_default')->default(false);
            $table->unsignedBigInteger('barcode_nomenclature_id')->nullable()->index(); // FK deferred
            $table->unsignedBigInteger('default_customer_id')->nullable()->index();     // FK deferred
            $table->boolean('receipt_use_ticket_qr')->default(true);
            $table->boolean('receipt_ticket_unique_code')->default(true);
            $table->string('receipt_ticket_url_display_mode', 24)->default(ReceiptTicketUrlDisplayMode::QrCode->value);
            $table->unsignedTinyInteger('stale_session_alert_days')->default(7);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('companies', [
            'tax_calculation_rounding_method' => TaxRoundingMethod::values(),
            'receipt_ticket_url_display_mode' => ReceiptTicketUrlDisplayMode::values(),
        ]);

        // Every image/attachment in the product: polymorphic, deduped by checksum.
        Schema::create('media_files', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('model_type', 96)->nullable()->index();
            $table->unsignedBigInteger('model_id')->nullable()->index();
            $table->string('collection', 48)->default(MediaCollection::Image->value)->index();
            $table->string('disk', 24)->default('public');
            $table->string('path', 512);
            $table->string('filename', 255);
            $table->string('mime_type', 96);
            $table->unsignedBigInteger('size_bytes');
            $table->unsignedSmallInteger('width')->nullable();
            $table->unsignedSmallInteger('height')->nullable();
            $table->char('checksum', 64)->index();
            $table->json('variants')->nullable();
            $table->boolean('is_public')->default(false);
            $table->integer('sort_order')->default(0);
            $table->timestamps();

            $table->index(['model_type', 'model_id', 'collection', 'sort_order'], 'media_files_morph_collection_index');
        });

        // --- Back-office user extensions -----------------------------------
        Schema::table('users', function (Blueprint $table): void {
            $table->unsignedBigInteger('company_id')->nullable()->after('id')->index(); // FK deferred
            $table->string('locale', 8)->default('en')->after('password');
            $table->unsignedBigInteger('avatar_media_id')->nullable()->after('locale')->index(); // FK deferred
            $table->boolean('is_super_admin')->default(false)->after('avatar_media_id');
            $table->timestamp('last_login_at')->nullable()->after('is_super_admin');
            $table->boolean('active')->default(true)->after('last_login_at')->index();
            $table->softDeletes();
        });

        Schema::create('roles', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 64);
            $table->string('slug', 64)->unique();
            $table->string('description', 255)->nullable();
            $table->boolean('is_system')->default(false);
            $table->timestamps();
        });

        Schema::create('permissions', function (Blueprint $table): void {
            $table->id();
            $table->string('slug', 96)->unique();
            $table->string('group', 48)->index();
            $table->string('description', 255)->nullable();
            $table->timestamps();
        });

        Schema::create('permission_role', function (Blueprint $table): void {
            $table->foreignId('role_id')->constrained()->cascadeOnDelete();
            $table->foreignId('permission_id')->constrained()->cascadeOnDelete();

            $table->primary(['role_id', 'permission_id']);
        });

        Schema::create('role_user', function (Blueprint $table): void {
            $table->foreignId('role_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            $table->primary(['role_id', 'user_id']);
        });

        // Cashier identity at the register: badge + PIN, never plaintext on the wire.
        Schema::create('employees', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->restrictOnDelete();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('name', 120)->index();
            $table->string('job_title', 80)->nullable();
            $table->foreignId('avatar_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->string('barcode', 64)->nullable();
            $table->char('barcode_hash', 64)->nullable()->index();
            $table->char('pin_hash', 64)->nullable();
            $table->string('default_role', 16)->default(EmployeeRole::Cashier->value);
            $table->unsignedTinyInteger('color')->default(0);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['company_id', 'barcode']);
        });

        $this->applyChecks('employees', ['default_role' => EmployeeRole::values()]);

        Schema::create('customers', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->restrictOnDelete();
            $table->foreignId('parent_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->string('address_type', 16)->default(AddressType::Contact->value);
            $table->boolean('is_company')->default(false);
            $table->string('name', 160)->index();
            $table->string('display_name', 200)->nullable();
            $table->string('email', 160)->nullable()->index();
            $table->string('phone', 40)->nullable()->index();
            $table->string('mobile', 40)->nullable()->index();
            $table->string('vat', 32)->nullable()->index();
            $table->string('street', 128)->nullable();
            $table->string('street2', 128)->nullable();
            $table->string('city', 96)->nullable();
            $table->string('zip', 24)->nullable()->index();
            $table->foreignId('state_id')->nullable()->constrained('country_states')->nullOnDelete();
            $table->foreignId('country_id')->nullable()->constrained()->nullOnDelete();
            $table->string('barcode', 64)->nullable();
            $table->string('locale', 8)->nullable();
            $table->unsignedBigInteger('pricelist_id')->nullable()->index();        // FK deferred
            $table->unsignedBigInteger('fiscal_position_id')->nullable()->index();  // FK deferred
            $table->decimal('loyalty_points_cache', 16, 3)->default(0);
            $table->unsignedInteger('order_count')->default(0)->index();
            $table->timestamp('last_order_at')->nullable()->index();
            $table->boolean('marketing_opt_in')->default(false);
            $table->text('note')->nullable();
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['company_id', 'barcode']);
        });

        $this->applyChecks('customers', ['address_type' => AddressType::values()]);
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn([
                'company_id', 'locale', 'avatar_media_id', 'is_super_admin',
                'last_login_at', 'active', 'deleted_at',
            ]);
        });

        Schema::dropIfExists('customers');
        Schema::dropIfExists('employees');
        Schema::dropIfExists('role_user');
        Schema::dropIfExists('permission_role');
        Schema::dropIfExists('permissions');
        Schema::dropIfExists('roles');
        Schema::dropIfExists('media_files');
        Schema::dropIfExists('companies');
        Schema::dropIfExists('languages');
        Schema::dropIfExists('country_states');
        Schema::dropIfExists('countries');
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
