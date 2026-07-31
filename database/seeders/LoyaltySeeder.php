<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Enums\AmountTaxMode;
use App\Enums\DiscountApplicability;
use App\Enums\DiscountMode;
use App\Enums\LoyaltyAppliesOn;
use App\Enums\LoyaltyCommunicationTrigger;
use App\Enums\LoyaltyMovementType;
use App\Enums\LoyaltyProgramType;
use App\Enums\LoyaltyRewardType;
use App\Enums\LoyaltyTrigger;
use App\Enums\RewardPointMode;
use Database\Seeders\Support\Demo;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

/**
 * Four loyalty programs, the cards they have already issued, and the ledger
 * behind those balances.
 *
 *  - "Carte fidélité Bistro"  — 1 point per € spent, nominative, two rewards;
 *  - "10ème café offert"      — buy-X-get-Y on the hot-drinks category;
 *  - "Carte cadeau"           — gift cards, one issued per €50 sold;
 *  - "BIENVENUE10"            — a code-triggered −10 % promotion.
 *
 * Query builder only: the `App\Models\Loyalty\*` models belong to another
 * workstream.
 */
class LoyaltySeeder extends Seeder
{
    public const PROGRAM_LOYALTY = 'Carte fidélité Bistro';

    public const PROGRAM_COFFEE = '10ème café offert';

    public const PROGRAM_GIFT_CARD = 'Carte cadeau';

    public const PROGRAM_PROMO = 'Promotion BIENVENUE10';

    private int $companyId;

    private int $currencyId;

    private string $now;

    public function run(): void
    {
        $rng = Demo::reseed('loyalty');

        $companyId = DB::table('companies')->where('name', Demo::COMPANY_NAME)->value('id');
        if ($companyId === null) {
            return;
        }
        $this->companyId = (int) $companyId;
        $this->currencyId = (int) DB::table('currencies')->where('code', 'EUR')->value('id');
        $this->now = Demo::ts(Demo::clock());

        if (DB::table('loyalty_programs')->where('company_id', $this->companyId)->exists()) {
            return;
        }

        $rewardProductId = (int) DB::table('products')
            ->where('company_id', $this->companyId)->where('name', 'Récompense fidélité')->value('id');
        $coffeeProductId = (int) DB::table('products')
            ->where('company_id', $this->companyId)->where('name', 'Café expresso')->value('id');
        $hotDrinksCategoryId = (int) DB::table('pos_categories')
            ->where('company_id', $this->companyId)->where('name', 'Boissons chaudes')->value('id');

        $loyaltyId = $this->seedLoyaltyProgram($rewardProductId);
        $coffeeId = $this->seedCoffeeProgram($coffeeProductId, $hotDrinksCategoryId);
        $giftCardId = $this->seedGiftCardProgram();
        $promoId = $this->seedPromoProgram($rewardProductId);

        $this->seedCommunications($loyaltyId, $giftCardId);
        $this->seedCards($loyaltyId, $coffeeId, $giftCardId, $promoId, $rng);
    }

    /** @param  array<string, mixed>  $overrides */
    private function createProgram(string $name, LoyaltyProgramType $type, array $overrides = []): int
    {
        return (int) DB::table('loyalty_programs')->insertGetId(array_merge([
            'company_id' => $this->companyId,
            'name' => $name,
            'program_type' => $type->value,
            'trigger' => LoyaltyTrigger::Auto->value,
            'applies_on' => LoyaltyAppliesOn::Current->value,
            'currency_id' => $this->currencyId,
            'date_from' => null,
            'date_to' => null,
            'limit_usage' => false,
            'max_usage' => null,
            'points_name' => 'Points',
            'is_nominative' => false,
            'is_payment_program' => false,
            'available_in_pos' => true,
            'print_report_on_issue' => false,
            'sequence' => 10,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ], $overrides));
    }

    private function seedLoyaltyProgram(int $rewardProductId): int
    {
        $programId = $this->createProgram(self::PROGRAM_LOYALTY, LoyaltyProgramType::Loyalty, [
            'is_nominative' => true,
            'points_name' => 'Points',
            'sequence' => 1,
        ]);

        DB::table('loyalty_rules')->insert([
            'loyalty_program_id' => $programId,
            'mode' => LoyaltyTrigger::Auto->value,
            'code' => null,
            'minimum_quantity' => '0.000',
            'minimum_amount' => '0.0000',
            'minimum_amount_tax_mode' => AmountTaxMode::Incl->value,
            'reward_point_amount' => '1.000',
            'reward_point_mode' => RewardPointMode::Money->value,
            'reward_point_split' => false,
            'applies_to_all_products' => true,
            'sequence' => 10,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        DB::table('loyalty_rewards')->insert([
            [
                'loyalty_program_id' => $programId,
                'reward_type' => LoyaltyRewardType::Discount->value,
                'description' => '5 € de remise (100 points)',
                'required_points' => '100.000',
                'clear_wallet' => false,
                'discount_value' => '5.0000',
                'discount_mode' => DiscountMode::PerOrder->value,
                'discount_applicability' => DiscountApplicability::Order->value,
                'discount_max_amount' => '5.0000',
                'is_global_discount' => false,
                'discount_line_product_id' => $rewardProductId,
                'reward_product_quantity' => '1.000',
                'multi_product' => false,
                'sequence' => 10,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
            [
                'loyalty_program_id' => $programId,
                'reward_type' => LoyaltyRewardType::Discount->value,
                'description' => '−10 % sur la commande (250 points)',
                'required_points' => '250.000',
                'clear_wallet' => false,
                'discount_value' => '10.0000',
                'discount_mode' => DiscountMode::Percent->value,
                'discount_applicability' => DiscountApplicability::Order->value,
                'discount_max_amount' => '25.0000',
                'is_global_discount' => true,
                'discount_line_product_id' => $rewardProductId,
                'reward_product_quantity' => '1.000',
                'multi_product' => false,
                'sequence' => 20,
                'active' => true,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
        ]);

        return $programId;
    }

    private function seedCoffeeProgram(int $coffeeProductId, int $hotDrinksCategoryId): int
    {
        $programId = $this->createProgram(self::PROGRAM_COFFEE, LoyaltyProgramType::BuyXGetY, [
            'is_nominative' => true,
            'points_name' => 'Cafés',
            'applies_on' => LoyaltyAppliesOn::Both->value,
            'sequence' => 2,
        ]);

        $ruleId = (int) DB::table('loyalty_rules')->insertGetId([
            'loyalty_program_id' => $programId,
            'mode' => LoyaltyTrigger::Auto->value,
            'code' => null,
            'minimum_quantity' => '1.000',
            'minimum_amount' => '0.0000',
            'minimum_amount_tax_mode' => AmountTaxMode::Incl->value,
            'reward_point_amount' => '1.000',
            'reward_point_mode' => RewardPointMode::Unit->value,
            'reward_point_split' => true,
            'applies_to_all_products' => false,
            'sequence' => 10,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        DB::table('loyalty_rule_pos_category')->insert([
            'loyalty_rule_id' => $ruleId,
            'pos_category_id' => $hotDrinksCategoryId,
        ]);

        $rewardId = (int) DB::table('loyalty_rewards')->insertGetId([
            'loyalty_program_id' => $programId,
            'reward_type' => LoyaltyRewardType::Product->value,
            'description' => 'Un café offert (10 cafés achetés)',
            'required_points' => '10.000',
            'clear_wallet' => false,
            'discount_value' => '0.0000',
            'discount_mode' => DiscountMode::Percent->value,
            'discount_applicability' => DiscountApplicability::Specific->value,
            'is_global_discount' => false,
            'reward_product_id' => $coffeeProductId,
            'reward_product_quantity' => '1.000',
            'multi_product' => false,
            'sequence' => 10,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        DB::table('loyalty_reward_product')->insert([
            'loyalty_reward_id' => $rewardId,
            'product_id' => $coffeeProductId,
        ]);

        return $programId;
    }

    private function seedGiftCardProgram(): int
    {
        $programId = $this->createProgram(self::PROGRAM_GIFT_CARD, LoyaltyProgramType::GiftCard, [
            'points_name' => 'Euros',
            'is_payment_program' => true,
            'print_report_on_issue' => true,
            'sequence' => 3,
        ]);

        DB::table('loyalty_rules')->insert([
            'loyalty_program_id' => $programId,
            'mode' => LoyaltyTrigger::WithCode->value,
            'code' => 'GIFT',
            'minimum_quantity' => '1.000',
            'minimum_amount' => '0.0000',
            'minimum_amount_tax_mode' => AmountTaxMode::Incl->value,
            'reward_point_amount' => '1.000',
            'reward_point_mode' => RewardPointMode::Money->value,
            'reward_point_split' => false,
            'applies_to_all_products' => true,
            'sequence' => 10,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        DB::table('loyalty_rewards')->insert([
            'loyalty_program_id' => $programId,
            'reward_type' => LoyaltyRewardType::Discount->value,
            'description' => 'Paiement par carte cadeau',
            'required_points' => '1.000',
            'clear_wallet' => true,
            'discount_value' => '1.0000',
            'discount_mode' => DiscountMode::PerPoint->value,
            'discount_applicability' => DiscountApplicability::Order->value,
            'is_global_discount' => false,
            'reward_product_quantity' => '1.000',
            'multi_product' => false,
            'sequence' => 10,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        return $programId;
    }

    private function seedPromoProgram(int $rewardProductId): int
    {
        $programId = $this->createProgram(self::PROGRAM_PROMO, LoyaltyProgramType::PromoCode, [
            'trigger' => LoyaltyTrigger::WithCode->value,
            'date_from' => Demo::day(30)->format('Y-m-d'),
            'date_to' => Demo::day(-60)->format('Y-m-d'),
            'limit_usage' => true,
            'max_usage' => 500,
            'points_name' => 'Codes',
            'sequence' => 4,
        ]);

        DB::table('loyalty_rules')->insert([
            'loyalty_program_id' => $programId,
            'mode' => LoyaltyTrigger::WithCode->value,
            'code' => 'BIENVENUE10',
            'promo_barcode' => '0491234567890',
            'minimum_quantity' => '1.000',
            'minimum_amount' => '20.0000',
            'minimum_amount_tax_mode' => AmountTaxMode::Incl->value,
            'reward_point_amount' => '1.000',
            'reward_point_mode' => RewardPointMode::Order->value,
            'reward_point_split' => false,
            'applies_to_all_products' => true,
            'sequence' => 10,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        DB::table('loyalty_rewards')->insert([
            'loyalty_program_id' => $programId,
            'reward_type' => LoyaltyRewardType::Discount->value,
            'description' => '−10 % de bienvenue (dès 20 €)',
            'required_points' => '1.000',
            'clear_wallet' => true,
            'discount_value' => '10.0000',
            'discount_mode' => DiscountMode::Percent->value,
            'discount_applicability' => DiscountApplicability::Order->value,
            'discount_max_amount' => '15.0000',
            'is_global_discount' => true,
            'discount_line_product_id' => $rewardProductId,
            'reward_product_quantity' => '1.000',
            'multi_product' => false,
            'sequence' => 10,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);

        return $programId;
    }

    private function seedCommunications(int $loyaltyId, int $giftCardId): void
    {
        $loyaltyTemplateId = DB::table('notification_templates')
            ->where('company_id', $this->companyId)->where('name', 'Points de fidélité')->value('id');
        $giftTemplateId = DB::table('notification_templates')
            ->where('company_id', $this->companyId)->where('name', 'Carte cadeau émise')->value('id');

        if ($loyaltyTemplateId === null || $giftTemplateId === null) {
            return;
        }

        DB::table('loyalty_communications')->insert([
            [
                'loyalty_program_id' => $loyaltyId,
                'trigger' => LoyaltyCommunicationTrigger::PointsReach->value,
                'points_threshold' => '100.000',
                'notification_template_id' => $loyaltyTemplateId,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
            [
                'loyalty_program_id' => $giftCardId,
                'trigger' => LoyaltyCommunicationTrigger::Create->value,
                'points_threshold' => null,
                'notification_template_id' => $giftTemplateId,
                'created_at' => $this->now,
                'updated_at' => $this->now,
            ],
        ]);
    }

    private function seedCards(int $loyaltyId, int $coffeeId, int $giftCardId, int $promoId, Demo $rng): void
    {
        $customers = DB::table('customers')
            ->where('company_id', $this->companyId)
            ->where('name', '!=', 'Client comptoir')
            ->orderBy('id')
            ->get();

        $cardIndex = 0;

        // Nominative loyalty accounts for the first eight regulars.
        foreach ($customers->take(8) as $customer) {
            $earned = $rng->int(40, 480);
            $spent = $rng->chance(40) ? $rng->int(0, 100) : 0;
            $balance = $earned - $spent;

            $cardId = $this->insertCard(
                $loyaltyId,
                'FID-'.strtoupper(Demo::token('loyalty:'.$customer->id, 8)),
                '049'.str_pad((string) (1000 + $cardIndex), 10, '0', STR_PAD_LEFT),
                (int) $customer->id,
                $balance,
                $earned,
                $spent,
                null,
                $rng->int(1, 12),
            );
            $cardIndex++;

            $this->insertHistory($cardId, LoyaltyMovementType::Earn, $earned, $earned, 'Cumul des achats des 30 derniers jours', 24);
            if ($spent > 0) {
                $this->insertHistory($cardId, LoyaltyMovementType::Spend, -$spent, $balance, 'Remise fidélité utilisée en caisse', 6);
            }

            DB::table('customers')->where('id', $customer->id)
                ->update(['loyalty_points_cache' => number_format((float) $balance, 3, '.', '')]);
        }

        // Coffee punch cards for four of them.
        foreach ($customers->take(4) as $customer) {
            $stamps = $rng->int(2, 9);
            $cardId = $this->insertCard(
                $coffeeId,
                'CAFE-'.strtoupper(Demo::token('coffee:'.$customer->id, 6)),
                null,
                (int) $customer->id,
                $stamps,
                $stamps,
                0,
                Demo::day(-180)->format('Y-m-d'),
                $stamps,
            );
            $this->insertHistory($cardId, LoyaltyMovementType::Earn, $stamps, $stamps, 'Cafés cumulés', 10);
        }

        // Anonymous gift cards, two of them already partly used.
        /** @var list<array{0:string,1:float,2:float}> $giftCards */
        $giftCards = [
            ['50.000', 50.0, 0.0],
            ['50.000', 50.0, 0.0],
            ['100.000', 100.0, 0.0],
            ['23.500', 50.0, 26.5],
            ['0.000', 30.0, 30.0],
        ];

        foreach ($giftCards as $index => [$balance, $issued, $spent]) {
            $cardId = $this->insertCard(
                $giftCardId,
                'CADEAU-'.strtoupper(Demo::token('gift:'.$index, 8)),
                '049'.str_pad((string) (5000 + $index), 10, '0', STR_PAD_LEFT),
                $index === 3 ? (int) $customers->first()->id : null,
                (float) $balance,
                $issued,
                $spent,
                Demo::day(-365)->format('Y-m-d'),
                $spent > 0 ? 1 : 0,
            );

            $this->insertHistory($cardId, LoyaltyMovementType::Issue, $issued, $issued, 'Émission de la carte cadeau', 28);
            if ($spent > 0.0) {
                $this->insertHistory($cardId, LoyaltyMovementType::Spend, -$spent, (float) $balance, 'Paiement par carte cadeau', 9);
            }
        }

        // Promo coupons handed out at the door.
        for ($index = 0; $index < 6; $index++) {
            $this->insertCard(
                $promoId,
                'BIENVENUE10-'.strtoupper(Demo::token('promo:'.$index, 5)),
                null,
                null,
                1.0,
                1.0,
                0.0,
                Demo::day(-90)->format('Y-m-d'),
                0,
            );
        }
    }

    private function insertCard(
        int $programId,
        string $code,
        ?string $barcode,
        ?int $customerId,
        float $points,
        float $issued,
        float $spent,
        ?string $expiresAt,
        int $useCount,
    ): int {
        return (int) DB::table('loyalty_cards')->insertGetId([
            'uuid' => Demo::uuid('loyalty-card:'.$code),
            'loyalty_program_id' => $programId,
            'company_id' => $this->companyId,
            'code' => $code,
            'barcode' => $barcode,
            'customer_id' => $customerId,
            'points' => number_format($points, 3, '.', ''),
            'points_issued_total' => number_format($issued, 3, '.', ''),
            'points_spent_total' => number_format($spent, 3, '.', ''),
            'expires_at' => $expiresAt,
            'use_count' => $useCount,
            'is_paid' => true,
            'active' => true,
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);
    }

    private function insertHistory(
        int $cardId,
        LoyaltyMovementType $type,
        float $points,
        float $balanceAfter,
        string $description,
        int $daysAgo,
    ): void {
        DB::table('loyalty_card_histories')->insert([
            'uuid' => Demo::uuid('loyalty-history:'.$cardId.':'.$type->value.':'.$daysAgo),
            'loyalty_card_id' => $cardId,
            'movement_type' => $type->value,
            'points' => number_format($points, 3, '.', ''),
            'balance_after' => number_format($balanceAfter, 3, '.', ''),
            'description' => $description,
            'occurred_at' => Demo::ms(Demo::at($daysAgo, 20, 15)),
            'created_at' => $this->now,
            'updated_at' => $this->now,
        ]);
    }
}
