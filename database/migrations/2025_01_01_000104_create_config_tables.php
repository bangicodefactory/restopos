<?php

declare(strict_types=1);

/**
 * Domain 4 — POS configuration (spec 01-schema §2.D).
 *
 * Tables created here:
 *   settings, notification_templates, payment_providers, payment_methods,
 *   pos_presets, preset_service_windows, pos_notes, pos_bills,
 *   pos_printers, pos_category_pos_printer,
 *   pos_configs,
 *   pos_config_payment_method, pos_config_pricelist, pos_config_fiscal_position,
 *   pos_config_preset, pos_config_printer, pos_config_note, pos_config_bill,
 *   pos_config_pos_category, pos_config_trusted_config, pos_config_language,
 *   pos_config_employee, pos_devices, sequences
 *
 * The remaining pos_config_* pivots live with the domain they point at:
 *   pos_config_floor (restaurant), pos_config_prep_display (kitchen),
 *   pos_config_self_order_custom_link (self-order).
 */

use App\Enums\AccessLevel;
use App\Enums\DayPeriod;
use App\Enums\DefaultScreen;
use App\Enums\DenominationType;
use App\Enums\DeviceType;
use App\Enums\NoteScope;
use App\Enums\NotificationChannel;
use App\Enums\NotificationPurpose;
use App\Enums\PaymentMethodType;
use App\Enums\PaymentProviderCode;
use App\Enums\PaymentProviderState;
use App\Enums\PresetIdentification;
use App\Enums\PresetServiceAt;
use App\Enums\PrinterType;
use App\Enums\QrCodeMethod;
use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Enums\SequencePurpose;
use App\Enums\SettingValueType;
use App\Enums\TaxDisplay;
use App\Enums\TerminalProvider;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Global key/value replacing ir.config_parameter.
        Schema::create('settings', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('key', 96);
            $table->text('value')->nullable();
            $table->string('value_type', 16)->default(SettingValueType::String->value);
            $table->timestamps();

            $table->unique(['company_id', 'key']);
        });

        $this->applyChecks('settings', ['value_type' => SettingValueType::values()]);

        Schema::create('notification_templates', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('channel', 8)->default(NotificationChannel::Email->value)->index();
            $table->string('purpose', 32)->index();
            $table->string('subject', 255)->nullable();
            $table->text('body');
            $table->boolean('attach_receipt_image')->default(false);
            $table->boolean('attach_invoice_pdf')->default(false);
            $table->foreignId('language_id')->nullable()->constrained('languages')->nullOnDelete();
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('notification_templates', [
            'channel' => NotificationChannel::values(),
            'purpose' => NotificationPurpose::values(),
        ]);

        Schema::create('payment_providers', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('code', 24);
            $table->string('state', 16)->default(PaymentProviderState::Disabled->value)->index();
            $table->json('credentials')->nullable();
            $table->boolean('requires_customer_email')->default(false);
            $table->json('supported_currencies')->nullable();
            $table->integer('sequence')->default(10);
            $table->timestamps();
        });

        $this->applyChecks('payment_providers', [
            'code' => PaymentProviderCode::values(),
            'state' => PaymentProviderState::values(),
        ]);

        Schema::create('payment_methods', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('method_type', 24)->default(PaymentMethodType::Bank->value)->index();
            $table->boolean('is_cash_count')->default(false)->index();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->boolean('identify_customer')->default(false);
            $table->boolean('allow_change')->default(false);
            $table->boolean('allow_refund')->default(true);
            $table->boolean('is_rounding_target')->default(false);
            $table->string('terminal_provider', 24)->default(TerminalProvider::None->value);
            $table->json('terminal_config')->nullable();
            $table->string('qr_code_method', 16)->default(QrCodeMethod::None->value);
            $table->text('default_qr_payload')->nullable();
            $table->foreignId('payment_provider_id')->nullable()->constrained('payment_providers')->restrictOnDelete();
            $table->string('ledger_code', 32)->nullable();
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->integer('sequence')->default(10)->index();
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('payment_methods', [
            'method_type' => PaymentMethodType::values(),
            'terminal_provider' => TerminalProvider::values(),
            'qr_code_method' => QrCodeMethod::values(),
        ]);

        // Order mode profile: Dine in / Takeaway / Delivery / Members.
        Schema::create('pos_presets', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->foreignId('pricelist_id')->nullable()->constrained('pricelists')->nullOnDelete();
            $table->foreignId('fiscal_position_id')->nullable()->constrained('fiscal_positions')->nullOnDelete();
            $table->string('identification', 16)->default(PresetIdentification::None->value);
            $table->boolean('is_return')->default(false);
            $table->boolean('use_guest')->default(false);
            $table->unsignedTinyInteger('color')->default(0);
            $table->foreignId('image_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->integer('sequence')->default(10);
            $table->boolean('use_timing')->default(false);
            $table->unsignedSmallInteger('slots_per_interval')->default(5);
            $table->unsignedSmallInteger('interval_minutes')->default(20);
            $table->boolean('available_in_self')->default(false)->index();
            $table->string('service_at', 16)->default(PresetServiceAt::Counter->value);
            $table->foreignId('notification_template_id')->nullable()->constrained('notification_templates')->nullOnDelete();
            $table->boolean('is_system')->default(false);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('pos_presets', [
            'identification' => PresetIdentification::values(),
            'service_at' => PresetServiceAt::values(),
        ]);

        // Opening hours per preset (replaces resource.calendar.attendance).
        Schema::create('preset_service_windows', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_preset_id')->constrained('pos_presets')->cascadeOnDelete();
            $table->unsignedTinyInteger('day_of_week'); // 0 = Monday … 6 = Sunday
            $table->decimal('hour_from', 5, 2);
            $table->decimal('hour_to', 5, 2);
            $table->string('day_period', 16)->nullable();
            $table->timestamps();

            $table->index(['pos_preset_id', 'day_of_week']);
        });

        $this->applyChecks('preset_service_windows', ['day_period' => DayPeriod::values()]);
        $this->applyRawChecks('preset_service_windows', [
            'preset_service_windows_hour_check' => '(hour_from < hour_to)',
            'preset_service_windows_dow_check' => '(day_of_week <= 6)',
        ]);

        Schema::create('pos_notes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->unsignedTinyInteger('color')->default(0);
            $table->string('note_scope', 8)->default(NoteScope::Line->value);
            $table->integer('sequence')->default(1);
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->unique(['company_id', 'name']);
        });

        $this->applyChecks('pos_notes', ['note_scope' => NoteScope::values()]);

        // Cash denominations for opening/closing counts.
        Schema::create('pos_bills', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->string('name', 32);
            $table->decimal('value', 16, 4);
            $table->string('denomination_type', 8)->default(DenominationType::Bill->value);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->index(['company_id', 'currency_id', 'value']);
        });

        $this->applyChecks('pos_bills', ['denomination_type' => DenominationType::values()]);

        Schema::create('pos_printers', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 64);
            $table->string('printer_type', 24)->default(PrinterType::EpsonEpos->value);
            $table->string('proxy_ip', 64)->nullable();
            $table->string('printer_ip', 128)->nullable();
            $table->unsignedSmallInteger('printer_port')->nullable();
            $table->string('serial_number', 64)->nullable();
            // ESC/POS command dialect. The transports render through `resolveProfile()`, which
            // falls back to `generic` — correct for an unknown model, wrong for a TM-T88 whose
            // cut and drawer-kick sequences differ. Nullable because most venues never set it.
            $table->string('profile', 32)->nullable();
            // Epson ePOS device id, the `devid` query parameter. A single TM-i exposes
            // `local_printer`; a multi-port unit exposes `local_printer2` and up, and without
            // this every port of it would be addressed as the first one.
            $table->string('epos_device_id', 32)->nullable();
            $table->boolean('is_receipt_printer')->default(false);
            $table->boolean('print_all_categories')->default(false);
            $table->unsignedTinyInteger('characters_per_line')->default(42);
            $table->unsignedTinyInteger('copies')->default(1);
            $table->unsignedSmallInteger('sequence')->default(0);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('pos_printers', ['printer_type' => PrinterType::values()]);

        Schema::create('pos_category_pos_printer', function (Blueprint $table): void {
            $table->foreignId('pos_printer_id')->constrained('pos_printers')->cascadeOnDelete();
            $table->foreignId('pos_category_id')->constrained('pos_categories')->cascadeOnDelete();

            $table->primary(['pos_printer_id', 'pos_category_id'], 'pos_category_pos_printer_primary');
        });

        // One register/terminal profile — the widest table in the schema.
        Schema::create('pos_configs', function (Blueprint $table): void {
            // Identity & infra
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96)->index();
            /*
             * What order and session numbers are prefixed with (BOF-045, BAN-488).
             *
             * `SequenceService::prefixFor()` derived this from the register's *name* — strip the
             * non-alphanumerics, take eight characters — so "Bar à vins" numbered orders `Bavins/00412`
             * and renaming the register silently renumbered everything after it. A venue whose
             * accountant expects one prefix per till had no way to say so.
             *
             * Null keeps the derived behaviour, which is what every existing register does.
             */
            $table->string('sequence_prefix', 8)->nullable();
            $table->char('access_token', 32)->unique();
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->foreignId('cash_rounding_id')->nullable()->constrained('cash_roundings')->restrictOnDelete();
            $table->boolean('use_cash_rounding')->default(false);
            $table->boolean('only_round_cash_payments')->default(true);
            $table->unsignedInteger('config_revision')->default(1);
            $table->timestamp('last_config_change_at', 3)->nullable();
            $table->boolean('active')->default(true)->index();

            // Catalog & pricing
            $table->foreignId('pricelist_id')->nullable()->constrained('pricelists')->restrictOnDelete();
            $table->boolean('use_pricelists')->default(false);
            $table->boolean('limit_categories')->default(false);
            $table->string('tax_display', 16)->default(TaxDisplay::Subtotal->value);
            $table->boolean('use_fiscal_positions')->default(false);
            $table->foreignId('default_fiscal_position_id')->nullable()->constrained('fiscal_positions')->restrictOnDelete();
            $table->boolean('show_product_images')->default(true);
            $table->boolean('show_category_images')->default(true);
            $table->boolean('group_products_by_category')->default(false);
            $table->boolean('allow_manual_discount')->default(true);
            $table->boolean('restrict_price_control')->default(false);
            $table->boolean('show_margins_to_all')->default(false);

            // Presets & tips
            $table->boolean('use_presets')->default(false);
            $table->foreignId('default_preset_id')->nullable()->constrained('pos_presets')->restrictOnDelete();
            $table->boolean('enable_tips')->default(false);
            $table->foreignId('tip_product_id')->nullable()->constrained('products')->restrictOnDelete();
            $table->boolean('tip_after_payment')->default(false);

            // Payments
            $table->boolean('has_cash_control')->default(false);
            $table->boolean('set_maximum_difference')->default(false);
            $table->decimal('amount_authorized_diff', 16, 4)->nullable();
            $table->boolean('auto_validate_terminal_payment')->default(true);
            $table->boolean('use_fast_payment')->default(false);
            $table->foreignId('self_order_online_payment_method_id')->nullable()->constrained('payment_methods')->nullOnDelete();

            // Receipts
            $table->boolean('show_receipt_header_footer')->default(false);
            $table->text('receipt_header')->nullable();
            $table->text('receipt_footer')->nullable();
            $table->boolean('basic_receipt')->default(false);
            $table->boolean('auto_print_receipt')->default(false);
            $table->boolean('skip_receipt_screen')->default(false);

            // Restaurant
            $table->boolean('is_restaurant')->default(false)->index();
            $table->boolean('enable_split_bill')->default(true);
            $table->boolean('enable_bill_print')->default(true);
            $table->string('default_screen', 16)->default(DefaultScreen::Tables->value);
            $table->unsignedSmallInteger('idle_return_seconds')->default(180);

            // Preparation / kitchen
            $table->boolean('use_preparation_printers')->default(false);
            $table->boolean('use_preparation_display')->default(false);
            $table->boolean('prep_auto_fire_first_course')->default(true);

            // Hardware
            $table->boolean('use_iot_box')->default(false);
            $table->string('proxy_ip', 64)->nullable();
            $table->boolean('iot_scan')->default(false);
            $table->boolean('iot_scale')->default(false);
            $table->boolean('iot_print')->default(false);
            $table->boolean('iot_cashdrawer')->default(false);
            $table->boolean('use_epos_printer')->default(false);
            $table->string('epos_printer_ip', 128)->nullable();
            $table->boolean('big_scrollbars')->default(false);
            $table->foreignId('customer_display_bg_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            // The receipt's brand mark. The client has always read this — `receipt.ts` builds its
            // blob key as `logo:{receipt_logo_media_id}` and `build.ts` emits the image node — but
            // the column was never added, so `config.receipt_logo_media_id` was permanently
            // undefined and every receipt printed without a logo (BAN-480).
            $table->foreignId('receipt_logo_media_id')->nullable()->constrained('media_files')->nullOnDelete();

            // Barcode
            $table->foreignId('fallback_barcode_nomenclature_id')->nullable()->constrained('barcode_nomenclatures')->nullOnDelete();

            // Self-order
            $table->string('self_ordering_mode', 16)->default(SelfOrderMode::Nothing->value)->index();
            $table->string('self_ordering_service_mode', 16)->default(SelfOrderServiceMode::Counter->value);
            $table->string('self_ordering_pay_after', 8)->default(SelfOrderPayAfter::Each->value);
            $table->foreignId('self_ordering_default_language_id')->nullable()->constrained('languages')->nullOnDelete();
            $table->foreignId('self_ordering_default_user_id')->nullable()->constrained('users')->restrictOnDelete();
            $table->string('self_ordering_brand_name', 96)->nullable();
            $table->foreignId('self_ordering_brand_media_id')->nullable()->constrained('media_files')->nullOnDelete();
            $table->string('self_ordering_primary_color', 9)->nullable();
            $table->string('self_ordering_text_color', 9)->nullable();
            $table->unsignedSmallInteger('kiosk_idle_seconds')->default(90);
            $table->unsignedSmallInteger('kiosk_confirmation_seconds')->default(30);

            // Global discount
            $table->boolean('enable_global_discount')->default(false);
            $table->decimal('global_discount_percent', 9, 4)->default(10);
            $table->foreignId('global_discount_product_id')->nullable()->constrained('products')->restrictOnDelete();

            // Feature flags & misc
            $table->boolean('use_employee_login')->default(false);
            $table->boolean('enable_loyalty')->default(false);
            $table->boolean('enable_sms_receipt')->default(false);
            $table->foreignId('sms_template_id')->nullable()->constrained('notification_templates')->nullOnDelete();
            $table->foreignId('email_receipt_template_id')->nullable()->constrained('notification_templates')->nullOnDelete();
            $table->boolean('order_edit_tracking')->default(false);
            // Per-register ability overrides, keyed by employee role (BOF-118, BAN-451).
            //
            // `EmployeeAuthService::abilitiesFor()` has read this since it was written — and the
            // column was never created, so `getAttribute('role_abilities')` answered null on every
            // register and the override has never once applied. `packages/domain/src/types.ts`
            // declares it too, so the client has been typed for a field the wire never carried.
            //
            // Null means "use the defaults in config/pos.php", which is not the same as an empty
            // object: `{}` is a deliberate override granting nothing.
            $table->json('role_abilities')->nullable();
            // The client version this register's devices are expected to be on (BAN-456).
            //
            // `config('pos.api.min_client_version')` is a deploy-wide constant shipped to every
            // client in the bootstrap. A venue that has not updated one terminal cannot be
            // expressed, and raising the floor for one venue raises it for all of them. Null falls
            // back to the deploy constant, so nothing changes for a venue that never sets it.
            $table->string('min_client_version', 32)->nullable();
            $table->unsignedInteger('limited_product_count')->default(5000);
            $table->unsignedInteger('limited_customer_count')->default(100);
            $table->timestamps();
            $table->softDeletes();
        });

        $this->applyChecks('pos_configs', [
            'tax_display' => TaxDisplay::values(),
            'default_screen' => DefaultScreen::values(),
            'self_ordering_mode' => SelfOrderMode::values(),
            'self_ordering_service_mode' => SelfOrderServiceMode::values(),
            'self_ordering_pay_after' => SelfOrderPayAfter::values(),
        ]);

        Schema::create('pos_config_payment_method', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('payment_method_id')->constrained('payment_methods')->cascadeOnDelete();
            $table->integer('sequence')->default(10);
            $table->boolean('is_fast_payment')->default(false);

            $table->primary(['pos_config_id', 'payment_method_id'], 'pos_config_payment_method_primary');
        });

        Schema::create('pos_config_pricelist', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pricelist_id')->constrained('pricelists')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'pricelist_id'], 'pos_config_pricelist_primary');
        });

        Schema::create('pos_config_fiscal_position', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('fiscal_position_id')->constrained('fiscal_positions')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'fiscal_position_id'], 'pos_config_fiscal_position_primary');
        });

        Schema::create('pos_config_preset', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_preset_id')->constrained('pos_presets')->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['pos_config_id', 'pos_preset_id'], 'pos_config_preset_primary');
        });

        Schema::create('pos_config_printer', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_printer_id')->constrained('pos_printers')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'pos_printer_id'], 'pos_config_printer_primary');
        });

        // A pos_note with NO row here is global to every config of the company, exactly like
        // `pos_config_bill` below (BAN-483). The scope enforcing that lives on the model.
        Schema::create('pos_config_note', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_note_id')->constrained('pos_notes')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'pos_note_id'], 'pos_config_note_primary');
        });

        // A pos_bill with NO row here is global to every config (Odoo semantics).
        Schema::create('pos_config_bill', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_bill_id')->constrained('pos_bills')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'pos_bill_id'], 'pos_config_bill_primary');
        });

        Schema::create('pos_config_pos_category', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('pos_category_id')->constrained('pos_categories')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'pos_category_id'], 'pos_config_pos_category_primary');
        });

        // Registers that share open orders. Bidirectional: the app writes both rows.
        Schema::create('pos_config_trusted_config', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('trusted_config_id')->constrained('pos_configs')->cascadeOnDelete();

            $table->primary(['pos_config_id', 'trusted_config_id'], 'pos_config_trusted_config_primary');
        });

        Schema::create('pos_config_language', function (Blueprint $table): void {
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('language_id')->constrained('languages')->cascadeOnDelete();
            $table->integer('sequence')->default(10);

            $table->primary(['pos_config_id', 'language_id'], 'pos_config_language_primary');
        });

        // Zero rows for a config ⇒ every active company employee may log in.
        Schema::create('pos_config_employee', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->foreignId('employee_id')->constrained('employees')->cascadeOnDelete();
            $table->string('access_level', 16)->default(AccessLevel::Basic->value);
            /*
             * A custom role for this employee on this register (BAN-451).
             *
             * `access_level` has three values and maps onto the three system roles, so it cannot
             * name "Shift lead". It also always has a value once an employee is attached, which
             * means `roleFor()` never reached `employees.default_role` for an attached employee —
             * so without this column a custom role would have applied to exactly the employees no
             * register had been given.
             *
             * Null means "use `access_level`", which is every row that exists today.
             */
            $table->string('role_slug', 32)->nullable();
            $table->timestamps();

            $table->unique(['pos_config_id', 'employee_id']);
        });

        $this->applyChecks('pos_config_employee', ['access_level' => AccessLevel::values()]);

        Schema::create('pos_devices', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();
            $table->unsignedInteger('device_identifier');
            $table->string('name', 80)->nullable();
            $table->string('device_type', 24)->default(DeviceType::Register->value);
            $table->string('user_agent', 255)->nullable();
            // BAN-456. `PairDeviceRequest` has validated `hardware_fingerprint` and
            // `app_version` since it was written, and `DevicePairingController` never passed either
            // to `pair()` — so both were validated and thrown away, and there was nowhere to put
            // them anyway.
            //
            // The fingerprint is what tells a re-paired terminal from a new one. Without it every
            // re-pair minted another row, and a venue's device list slowly filled with ghosts of
            // machines still sitting on the counter.
            $table->string('hardware_fingerprint', 128)->nullable()->index();
            $table->string('app_version', 32)->nullable();
            $table->timestamp('paired_at')->nullable();
            $table->timestamp('last_seen_at')->nullable()->index();
            $table->timestamp('last_synced_at', 3)->nullable();
            $table->boolean('has_paper')->default(true);
            $table->foreignId('current_employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->boolean('active')->default(true);
            $table->timestamps();

            $table->unique(['pos_config_id', 'device_identifier']);
        });

        $this->applyChecks('pos_devices', ['device_type' => DeviceType::values()]);

        // Atomic counters replacing ir.sequence.
        Schema::create('sequences', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->foreignId('pos_config_id')->nullable()->constrained('pos_configs')->cascadeOnDelete();
            $table->string('purpose', 16);
            $table->string('period_key', 8)->nullable();
            $table->string('prefix', 32)->nullable();
            $table->unsignedTinyInteger('padding')->default(6);
            $table->unsignedBigInteger('next_value')->default(1);
            $table->timestamps();

            $table->unique(['company_id', 'pos_config_id', 'purpose', 'period_key'], 'sequences_scope_unique');
        });

        $this->applyChecks('sequences', ['purpose' => SequencePurpose::values()]);
    }

    public function down(): void
    {
        Schema::dropIfExists('sequences');
        Schema::dropIfExists('pos_devices');
        Schema::dropIfExists('pos_config_employee');
        Schema::dropIfExists('pos_config_language');
        Schema::dropIfExists('pos_config_trusted_config');
        Schema::dropIfExists('pos_config_pos_category');
        Schema::dropIfExists('pos_config_bill');
        Schema::dropIfExists('pos_config_note');
        Schema::dropIfExists('pos_config_printer');
        Schema::dropIfExists('pos_config_preset');
        Schema::dropIfExists('pos_config_fiscal_position');
        Schema::dropIfExists('pos_config_pricelist');
        Schema::dropIfExists('pos_config_payment_method');
        Schema::dropIfExists('pos_configs');
        Schema::dropIfExists('pos_category_pos_printer');
        Schema::dropIfExists('pos_printers');
        Schema::dropIfExists('pos_bills');
        Schema::dropIfExists('pos_notes');
        Schema::dropIfExists('preset_service_windows');
        Schema::dropIfExists('pos_presets');
        Schema::dropIfExists('payment_methods');
        Schema::dropIfExists('payment_providers');
        Schema::dropIfExists('notification_templates');
        Schema::dropIfExists('settings');
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
