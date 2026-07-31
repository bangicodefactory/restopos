<?php

declare(strict_types=1);

/**
 * Domain 10 — Loyalty & promotions (spec 01-schema §2.J).
 *
 * Tables created here:
 *   loyalty_programs, loyalty_program_pos_config, loyalty_program_pricelist,
 *   loyalty_rules, loyalty_rule_product, loyalty_rule_pos_category,
 *   loyalty_rule_product_tag, loyalty_rewards, loyalty_reward_product,
 *   loyalty_cards, loyalty_card_histories, pos_order_loyalty_points,
 *   loyalty_communications
 *
 * `pos_order_lines.loyalty_reward_id` / `loyalty_card_id` get their FK in
 * 2025_01_01_000112_add_deferred_foreign_keys (the order domain runs earlier).
 */

use App\Enums\AmountTaxMode;
use App\Enums\DiscountApplicability;
use App\Enums\DiscountMode;
use App\Enums\LoyaltyAppliesOn;
use App\Enums\LoyaltyCommunicationTrigger;
use App\Enums\LoyaltyMovementType;
use App\Enums\LoyaltyPointState;
use App\Enums\LoyaltyProgramType;
use App\Enums\LoyaltyRewardType;
use App\Enums\LoyaltyTrigger;
use App\Enums\RewardPointMode;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('loyalty_programs', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('name', 96);
            $table->string('program_type', 24)->index();
            $table->string('trigger', 16)->default(LoyaltyTrigger::Auto->value);
            $table->string('applies_on', 16)->default(LoyaltyAppliesOn::Current->value);
            $table->foreignId('currency_id')->constrained()->restrictOnDelete();
            $table->date('date_from')->nullable()->index();
            $table->date('date_to')->nullable()->index();
            $table->boolean('limit_usage')->default(false);
            $table->unsignedInteger('max_usage')->nullable();
            $table->string('points_name', 32)->default('Points');
            $table->boolean('is_nominative')->default(false);
            $table->boolean('is_payment_program')->default(false);
            $table->boolean('available_in_pos')->default(true)->index();
            $table->boolean('print_report_on_issue')->default(false);
            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        $this->applyChecks('loyalty_programs', [
            'program_type' => LoyaltyProgramType::values(),
            'trigger' => LoyaltyTrigger::values(),
            'applies_on' => LoyaltyAppliesOn::values(),
        ]);

        // Empty pivot ⇒ the program applies to every config (Odoo semantics).
        Schema::create('loyalty_program_pos_config', function (Blueprint $table): void {
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->foreignId('pos_config_id')->constrained('pos_configs')->cascadeOnDelete();

            $table->primary(['loyalty_program_id', 'pos_config_id'], 'loyalty_program_pos_config_primary');
        });

        Schema::create('loyalty_program_pricelist', function (Blueprint $table): void {
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->foreignId('pricelist_id')->constrained('pricelists')->cascadeOnDelete();

            $table->primary(['loyalty_program_id', 'pricelist_id'], 'loyalty_program_pricelist_primary');
        });

        // Earning / triggering conditions. Odoo's arbitrary `domain` is replaced
        // by explicit product / category / tag pivots so the client can evaluate offline.
        Schema::create('loyalty_rules', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->string('mode', 16)->default(LoyaltyTrigger::Auto->value);
            $table->string('code', 48)->nullable();
            $table->string('promo_barcode', 64)->nullable()->index();
            $table->decimal('minimum_quantity', 16, 3)->default(0);
            $table->decimal('minimum_amount', 16, 4)->default(0);
            $table->string('minimum_amount_tax_mode', 8)->default(AmountTaxMode::Incl->value);
            $table->decimal('reward_point_amount', 16, 3)->default(1);
            $table->string('reward_point_mode', 16)->default(RewardPointMode::Order->value);
            $table->boolean('reward_point_split')->default(false);
            $table->boolean('applies_to_all_products')->default(true);
            $table->integer('sequence')->default(10);
            $table->timestamps();

            $table->unique(['loyalty_program_id', 'code']);
        });

        $this->applyChecks('loyalty_rules', [
            'mode' => LoyaltyTrigger::values(),
            'minimum_amount_tax_mode' => AmountTaxMode::values(),
            'reward_point_mode' => RewardPointMode::values(),
        ]);

        Schema::create('loyalty_rule_product', function (Blueprint $table): void {
            $table->foreignId('loyalty_rule_id')->constrained('loyalty_rules')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();

            $table->primary(['loyalty_rule_id', 'product_id'], 'loyalty_rule_product_primary');
        });

        Schema::create('loyalty_rule_pos_category', function (Blueprint $table): void {
            $table->foreignId('loyalty_rule_id')->constrained('loyalty_rules')->cascadeOnDelete();
            $table->foreignId('pos_category_id')->constrained('pos_categories')->cascadeOnDelete();

            $table->primary(['loyalty_rule_id', 'pos_category_id'], 'loyalty_rule_pos_category_primary');
        });

        Schema::create('loyalty_rule_product_tag', function (Blueprint $table): void {
            $table->foreignId('loyalty_rule_id')->constrained('loyalty_rules')->cascadeOnDelete();
            $table->foreignId('product_tag_id')->constrained('product_tags')->cascadeOnDelete();

            $table->primary(['loyalty_rule_id', 'product_tag_id'], 'loyalty_rule_product_tag_primary');
        });

        Schema::create('loyalty_rewards', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->string('reward_type', 16)->default(LoyaltyRewardType::Discount->value);
            $table->string('description', 160);
            $table->decimal('required_points', 16, 3)->default(1);
            $table->boolean('clear_wallet')->default(false);

            // Discount reward
            $table->decimal('discount_value', 16, 4)->default(0);
            $table->string('discount_mode', 16)->default(DiscountMode::Percent->value);
            $table->string('discount_applicability', 16)->default(DiscountApplicability::Order->value);
            $table->decimal('discount_max_amount', 16, 4)->nullable();
            $table->boolean('is_global_discount')->default(false);
            $table->foreignId('discount_line_product_id')->nullable()->constrained('products')->restrictOnDelete();

            // Free-product reward
            $table->foreignId('reward_product_id')->nullable()->constrained('products')->restrictOnDelete();
            $table->decimal('reward_product_quantity', 16, 3)->default(1);
            $table->boolean('multi_product')->default(false);

            $table->integer('sequence')->default(10);
            $table->boolean('active')->default(true);
            $table->timestamps();
        });

        $this->applyChecks('loyalty_rewards', [
            'reward_type' => LoyaltyRewardType::values(),
            'discount_mode' => DiscountMode::values(),
            'discount_applicability' => DiscountApplicability::values(),
        ]);

        Schema::create('loyalty_reward_product', function (Blueprint $table): void {
            $table->foreignId('loyalty_reward_id')->constrained('loyalty_rewards')->cascadeOnDelete();
            $table->foreignId('product_id')->constrained()->cascadeOnDelete();

            $table->primary(['loyalty_reward_id', 'product_id'], 'loyalty_reward_product_primary');
        });

        // A coupon / gift card / eWallet / loyalty account instance.
        Schema::create('loyalty_cards', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->foreignId('company_id')->constrained()->cascadeOnDelete();
            $table->string('code', 48)->unique();
            $table->string('barcode', 64)->nullable()->index();
            $table->foreignId('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->decimal('points', 16, 3)->default(0)->index();
            $table->decimal('points_issued_total', 16, 3)->default(0);
            $table->decimal('points_spent_total', 16, 3)->default(0);
            $table->date('expires_at')->nullable()->index();
            $table->unsignedInteger('use_count')->default(0);
            $table->foreignId('source_pos_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->boolean('is_paid')->default(true);
            $table->boolean('active')->default(true)->index();
            $table->timestamps();
        });

        // Immutable ledger of point movements.
        Schema::create('loyalty_card_histories', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('loyalty_card_id')->constrained('loyalty_cards')->cascadeOnDelete();
            $table->foreignId('pos_order_id')->nullable()->constrained('pos_orders')->nullOnDelete();
            $table->string('movement_type', 16)->default(LoyaltyMovementType::Earn->value)->index();
            $table->decimal('points', 16, 3);
            $table->decimal('balance_after', 16, 3);
            $table->string('description', 160)->nullable();
            $table->foreignId('employee_id')->nullable()->constrained('employees')->nullOnDelete();
            $table->timestamp('occurred_at', 3)->index();
            $table->timestamps();
        });

        $this->applyChecks('loyalty_card_histories', ['movement_type' => LoyaltyMovementType::values()]);

        // Point changes claimed by one order: staged at sync, confirmed at payment.
        Schema::create('pos_order_loyalty_points', function (Blueprint $table): void {
            $table->id();
            $table->char('uuid', 36)->unique();
            $table->foreignId('pos_order_id')->constrained('pos_orders')->cascadeOnDelete();
            $table->foreignId('loyalty_card_id')->nullable()->constrained('loyalty_cards')->nullOnDelete();
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->restrictOnDelete();
            $table->decimal('points_delta', 16, 3);
            $table->string('new_card_code', 48)->nullable();
            $table->string('state', 16)->default(LoyaltyPointState::Pending->value)->index();
            $table->string('rejection_reason', 160)->nullable();
            $table->timestamp('confirmed_at', 3)->nullable();
            $table->timestamps();
        });

        $this->applyChecks('pos_order_loyalty_points', ['state' => LoyaltyPointState::values()]);

        Schema::create('loyalty_communications', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('loyalty_program_id')->constrained('loyalty_programs')->cascadeOnDelete();
            $table->string('trigger', 16)->default(LoyaltyCommunicationTrigger::Create->value);
            $table->decimal('points_threshold', 16, 3)->nullable();
            $table->foreignId('notification_template_id')->constrained('notification_templates')->restrictOnDelete();
            $table->timestamps();
        });

        $this->applyChecks('loyalty_communications', ['trigger' => LoyaltyCommunicationTrigger::values()]);
    }

    public function down(): void
    {
        Schema::dropIfExists('loyalty_communications');
        Schema::dropIfExists('pos_order_loyalty_points');
        Schema::dropIfExists('loyalty_card_histories');
        Schema::dropIfExists('loyalty_cards');
        Schema::dropIfExists('loyalty_reward_product');
        Schema::dropIfExists('loyalty_rewards');
        Schema::dropIfExists('loyalty_rule_product_tag');
        Schema::dropIfExists('loyalty_rule_pos_category');
        Schema::dropIfExists('loyalty_rule_product');
        Schema::dropIfExists('loyalty_rules');
        Schema::dropIfExists('loyalty_program_pricelist');
        Schema::dropIfExists('loyalty_program_pos_config');
        Schema::dropIfExists('loyalty_programs');
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
